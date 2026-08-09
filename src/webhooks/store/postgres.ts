import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { assertStandardWebhookSecret } from "../delivery/signing.js";
import {
    isWebhookTargetPolicyError,
    type WebhookTargetPolicy,
} from "../delivery/target-policy.js";
import type {
    ClaimedWebhookDelivery,
    WebhookDeliveryStore,
} from "../delivery/worker.js";
import type { WebhookSecretCipher } from "./secret-cipher.js";

export type WebhookEndpointView = Readonly<{
    endpointId: string;
    ownerId: string;
    url: string;
    status: "enabled" | "disabled";
    createdAt: string;
    updatedAt: string;
    disabledAt?: string;
}>;

export type WebhookEndpointAuditView = Readonly<{
    auditId: string;
    endpointId: string;
    ownerId: string;
    actorId: string;
    action:
        | "provisioned"
        | "registration_rejected"
        | "url_updated"
        | "url_update_rejected"
        | "secret_rotated"
        | "disabled"
        | "delivery_target_rejected";
    reasonCode?: string;
    createdAt: string;
}>;

export type WebhookDeliveryView = Readonly<{
    deliveryId: string;
    eventId: string;
    endpointId: string;
    runId: string;
    eventType: "process_run.succeeded" | "process_run.failed";
    status: "pending" | "delivering" | "succeeded" | "failed" | "exhausted";
    attemptCount: number;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    lastHttpStatus?: number;
    lastErrorCode?: string;
    replayNumber: number;
    replayOfDeliveryId?: string;
}>;

export type WebhookDeliveryAttemptView = Readonly<{
    deliveryId: string;
    eventId: string;
    runId: string;
    endpointId: string;
    attemptNumber: number;
    outcome: "started" | "succeeded" | "failed";
    startedAt: string;
    finishedAt?: string;
    latencyMs?: number;
    httpStatus?: number;
    errorCode?: string;
    nextAttemptAt?: string;
}>;

export type PostgresWebhookDeliveryStore = WebhookDeliveryStore &
    Readonly<{
        provisionEndpoint: (candidate: {
            endpointId: string;
            ownerId: string;
            actorId: string;
            url: string;
            secret: string;
            createdAt: string;
        }) => Promise<WebhookEndpointView>;
        findEndpoints: (request: {
            ownerId: string;
        }) => Promise<readonly WebhookEndpointView[]>;
        updateEndpointUrl: (request: {
            endpointId: string;
            ownerId: string;
            actorId: string;
            url: string;
            updatedAt: string;
        }) => Promise<WebhookEndpointView | undefined>;
        rotateEndpointSecret: (request: {
            endpointId: string;
            ownerId: string;
            actorId: string;
            secret: string;
            rotatedAt: string;
            overlapMs: number;
        }) => Promise<WebhookEndpointView | undefined>;
        disableEndpoint: (request: {
            endpointId: string;
            ownerId: string;
            actorId: string;
            disabledAt: string;
        }) => Promise<WebhookEndpointView | undefined>;
        findEndpointAudit: (request: {
            ownerId: string;
            endpointId: string;
            limit?: number;
        }) => Promise<readonly WebhookEndpointAuditView[]>;
        findByRun: (request: {
            ownerId: string;
            runIds: readonly string[];
        }) => Promise<readonly WebhookDeliveryView[]>;
        findByEvent: (request: {
            ownerId: string;
            eventIds: readonly string[];
        }) => Promise<readonly WebhookDeliveryView[]>;
        findByEndpoint: (request: {
            ownerId: string;
            endpointId: string;
            limit?: number;
        }) => Promise<readonly WebhookDeliveryView[]>;
        findAttempts: (request: {
            ownerId: string;
            deliveryId: string;
        }) => Promise<readonly WebhookDeliveryAttemptView[]>;
        replay: (request: {
            ownerId: string;
            deliveryId: string;
            actorId: string;
            replayedAt: string;
        }) => Promise<WebhookDeliveryView | undefined>;
        ready: () => Promise<void>;
    }>;

export function createPostgresWebhookDeliveryStore(options: {
    pool: Pool;
    secretCipher: WebhookSecretCipher;
    targetPolicy: WebhookTargetPolicy;
    claimLeaseMs?: number;
    createDeliveryId?: () => string;
    createOutboxMessageId?: () => string;
    createReplayId?: () => string;
    createAuditId?: () => string;
}): PostgresWebhookDeliveryStore {
    const claimLeaseMs = positiveInteger(
        options.claimLeaseMs ?? 30_000,
        "Webhook Delivery claim lease",
    );
    const createDeliveryId = options.createDeliveryId ?? randomUUID;
    const createOutboxMessageId = options.createOutboxMessageId ?? randomUUID;
    const createReplayId = options.createReplayId ?? randomUUID;
    const createAuditId = options.createAuditId ?? randomUUID;

    return Object.freeze({
        provisionEndpoint: async (candidate) => {
            assertUuid(candidate.endpointId, "Webhook Endpoint ID");
            assertOwner(candidate.ownerId);
            assertOwner(candidate.actorId);
            assertStandardWebhookSecret(candidate.secret);
            timestampMilliseconds(candidate.createdAt);
            let url: string;
            try {
                url = (await options.targetPolicy.resolve(candidate.url)).url;
            } catch (error) {
                if (isWebhookTargetPolicyError(error)) {
                    await insertEndpointAudit(options.pool, {
                        auditId: createAuditId(),
                        endpointId: candidate.endpointId,
                        ownerId: candidate.ownerId,
                        actorId: candidate.actorId,
                        action: "registration_rejected",
                        reasonCode: error.code,
                        createdAt: candidate.createdAt,
                    });
                }
                throw error;
            }
            const secretEnvelope = options.secretCipher.encrypt(
                candidate.secret,
                candidate.endpointId,
            );
            return transaction(options.pool, async (client) => {
                const result = await client.query<EndpointRow>(
                    `
            INSERT INTO webhook_endpoints (
              endpoint_id,
              caller_id,
              url,
              current_secret_envelope,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $5)
            RETURNING *
          `,
                    [
                        candidate.endpointId,
                        candidate.ownerId,
                        url,
                        secretEnvelope,
                        candidate.createdAt,
                    ],
                );
                await insertEndpointAudit(client, {
                    auditId: createAuditId(),
                    endpointId: candidate.endpointId,
                    ownerId: candidate.ownerId,
                    actorId: candidate.actorId,
                    action: "provisioned",
                    createdAt: candidate.createdAt,
                });
                const row = result.rows[0];
                if (!row) throw new Error("Webhook Endpoint was not persisted");
                return endpointFromRow(row);
            });
        },

        findEndpoints: async (request) => {
            assertOwner(request.ownerId);
            const result = await options.pool.query<EndpointRow>(
                `
          SELECT *
          FROM webhook_endpoints
          WHERE caller_id = $1
          ORDER BY created_at, endpoint_id
        `,
                [request.ownerId],
            );
            return result.rows.map(endpointFromRow);
        },

        updateEndpointUrl: async (request) => {
            assertUuid(request.endpointId, "Webhook Endpoint ID");
            assertOwner(request.ownerId);
            assertOwner(request.actorId);
            timestampMilliseconds(request.updatedAt);
            const owned = await options.pool.query(
                `
          SELECT 1
          FROM webhook_endpoints
          WHERE endpoint_id = $1 AND caller_id = $2
        `,
                [request.endpointId, request.ownerId],
            );
            if (owned.rowCount !== 1) return undefined;
            let url: string;
            try {
                url = (await options.targetPolicy.resolve(request.url)).url;
            } catch (error) {
                if (isWebhookTargetPolicyError(error)) {
                    await insertEndpointAudit(options.pool, {
                        auditId: createAuditId(),
                        endpointId: request.endpointId,
                        ownerId: request.ownerId,
                        actorId: request.actorId,
                        action: "url_update_rejected",
                        reasonCode: error.code,
                        createdAt: request.updatedAt,
                    });
                }
                throw error;
            }
            return transaction(options.pool, async (client) => {
                const result = await client.query<EndpointRow>(
                    `
            UPDATE webhook_endpoints
            SET url = $3, updated_at = $4
            WHERE endpoint_id = $1 AND caller_id = $2
            RETURNING *
          `,
                    [
                        request.endpointId,
                        request.ownerId,
                        url,
                        request.updatedAt,
                    ],
                );
                const row = result.rows[0];
                if (!row) return undefined;
                await insertEndpointAudit(client, {
                    auditId: createAuditId(),
                    endpointId: request.endpointId,
                    ownerId: request.ownerId,
                    actorId: request.actorId,
                    action: "url_updated",
                    createdAt: request.updatedAt,
                });
                return endpointFromRow(row);
            });
        },

        rotateEndpointSecret: async (request) => {
            assertUuid(request.endpointId, "Webhook Endpoint ID");
            assertOwner(request.ownerId);
            assertOwner(request.actorId);
            assertStandardWebhookSecret(request.secret);
            const rotatedAtMs = timestampMilliseconds(request.rotatedAt);
            const overlapMs = boundedInteger(
                request.overlapMs,
                1,
                604_800_000,
                "Webhook Secret overlap",
            );
            const previousValidUntil = new Date(
                rotatedAtMs + overlapMs,
            ).toISOString();
            const nextEnvelope = options.secretCipher.encrypt(
                request.secret,
                request.endpointId,
            );
            return transaction(options.pool, async (client) => {
                const result = await client.query<EndpointRow>(
                    `
            UPDATE webhook_endpoints
            SET
              previous_secret_envelope = current_secret_envelope,
              previous_secret_valid_until = $4,
              current_secret_envelope = $3,
              updated_at = $5
            WHERE endpoint_id = $1 AND caller_id = $2
            RETURNING *
          `,
                    [
                        request.endpointId,
                        request.ownerId,
                        nextEnvelope,
                        previousValidUntil,
                        request.rotatedAt,
                    ],
                );
                const row = result.rows[0];
                if (!row) return undefined;
                await insertEndpointAudit(client, {
                    auditId: createAuditId(),
                    endpointId: request.endpointId,
                    ownerId: request.ownerId,
                    actorId: request.actorId,
                    action: "secret_rotated",
                    createdAt: request.rotatedAt,
                });
                return endpointFromRow(row);
            });
        },

        disableEndpoint: async (request) => {
            assertUuid(request.endpointId, "Webhook Endpoint ID");
            assertOwner(request.ownerId);
            assertOwner(request.actorId);
            timestampMilliseconds(request.disabledAt);
            return transaction(options.pool, async (client) => {
                const result = await client.query<EndpointRow>(
                    `
            UPDATE webhook_endpoints
            SET status = 'disabled', disabled_at = $3, updated_at = $3
            WHERE
              endpoint_id = $1
              AND caller_id = $2
              AND status = 'enabled'
            RETURNING *
          `,
                    [request.endpointId, request.ownerId, request.disabledAt],
                );
                const row = result.rows[0];
                if (!row) return undefined;
                await insertEndpointAudit(client, {
                    auditId: createAuditId(),
                    endpointId: request.endpointId,
                    ownerId: request.ownerId,
                    actorId: request.actorId,
                    action: "disabled",
                    createdAt: request.disabledAt,
                });
                return endpointFromRow(row);
            });
        },

        findEndpointAudit: async (request) => {
            assertOwner(request.ownerId);
            if (!isUuid(request.endpointId)) return [];
            const limit = boundedInteger(
                request.limit ?? 100,
                1,
                100,
                "Webhook Endpoint audit lookup limit",
            );
            const result = await options.pool.query<EndpointAuditRow>(
                `
          SELECT *
          FROM webhook_endpoint_audit_events
          WHERE caller_id = $1 AND endpoint_id = $2
          ORDER BY created_at, audit_id
          LIMIT $3
        `,
                [request.ownerId, request.endpointId, limit],
            );
            return result.rows.map(endpointAuditFromRow);
        },

        claim: async (request): Promise<ClaimedWebhookDelivery | undefined> => {
            if (!isUuid(request.deliveryId) || !isUuid(request.claimToken)) {
                return undefined;
            }
            const claimExpiresAt = addMilliseconds(
                request.claimedAt,
                claimLeaseMs,
            );
            return transaction(options.pool, async (client) => {
                const result = await client.query<ClaimedDeliveryRow>(
                    `
            UPDATE webhook_deliveries AS deliveries
            SET
              status = 'delivering',
              attempt_count = deliveries.attempt_count + 1,
              claim_token = $2,
              claim_expires_at = $4,
              updated_at = $3
            FROM webhook_endpoints AS endpoints
            WHERE
              deliveries.delivery_id = $1
              AND deliveries.endpoint_id = endpoints.endpoint_id
              AND deliveries.status = 'pending'
              AND deliveries.next_attempt_at <= $3
              AND endpoints.status = 'enabled'
            RETURNING
              deliveries.delivery_id,
              deliveries.event_id,
              deliveries.endpoint_id,
              deliveries.payload,
              deliveries.claim_token,
              deliveries.attempt_count,
              deliveries.created_at,
              endpoints.url,
              endpoints.current_secret_envelope,
              CASE
                WHEN endpoints.previous_secret_valid_until >= $3
                THEN endpoints.previous_secret_envelope
                ELSE NULL
              END AS previous_secret_envelope
          `,
                    [
                        request.deliveryId,
                        request.claimToken,
                        request.claimedAt,
                        claimExpiresAt,
                    ],
                );
                const row = result.rows[0];
                if (!row) return undefined;
                await client.query(
                    `
            INSERT INTO webhook_delivery_attempts (
              delivery_id,
              attempt_number,
              started_at,
              outcome
            )
            VALUES ($1, $2, $3, 'started')
          `,
                    [row.delivery_id, row.attempt_count, request.claimedAt],
                );
                return claimedDeliveryFromRow(row, options.secretCipher);
            });
        },

        complete: async (request) => {
            if (!isUuid(request.deliveryId) || !isUuid(request.claimToken)) {
                return false;
            }
            timestampMilliseconds(request.completedAt);
            validateSendResult(request.result);
            const failedResult =
                request.result.outcome === "failed"
                    ? request.result
                    : undefined;
            if (
                request.result.outcome === "succeeded" &&
                (request.terminalStatus !== undefined ||
                    request.disableEndpoint === true)
            ) {
                throw new Error(
                    "A successful Webhook Delivery cannot use failure controls",
                );
            }
            if (
                request.disableEndpoint === true &&
                failedResult?.httpStatus !== 410 &&
                failedResult?.errorCode !== "TARGET_REJECTED"
            ) {
                throw new Error(
                    "Only HTTP 410 or a rejected target can disable a Webhook Endpoint",
                );
            }

            return transaction(options.pool, async (client) => {
                const selected = await client.query<DeliveryRow>(
                    `
            SELECT *
            FROM webhook_deliveries
            WHERE delivery_id = $1
            FOR UPDATE
          `,
                    [request.deliveryId],
                );
                const delivery = selected.rows[0];
                if (
                    delivery?.status !== "delivering" ||
                    delivery.claim_token !== request.claimToken
                ) {
                    return false;
                }
                const httpStatus = request.result.httpStatus ?? null;
                const errorCode = failedResult
                    ? (failedResult.targetRejectionCode ??
                      failedResult.errorCode)
                    : null;
                const nextStatus =
                    request.result.outcome === "succeeded"
                        ? "succeeded"
                        : (request.terminalStatus ?? "failed");
                if (
                    nextStatus !== "succeeded" &&
                    nextStatus !== "failed" &&
                    nextStatus !== "exhausted"
                ) {
                    throw new Error(
                        "Webhook Delivery terminal status is invalid",
                    );
                }
                const updated = await client.query(
                    `
            UPDATE webhook_deliveries
            SET
              status = $3,
              claim_token = NULL,
              claim_expires_at = NULL,
              last_http_status = $5,
              last_error_code = $6,
              updated_at = $4,
              completed_at = $4
            WHERE
              delivery_id = $1
              AND claim_token = $2
              AND status = 'delivering'
          `,
                    [
                        request.deliveryId,
                        request.claimToken,
                        nextStatus,
                        request.completedAt,
                        httpStatus,
                        errorCode,
                    ],
                );
                if (updated.rowCount !== 1) return false;
                await recordAttempt(
                    client,
                    delivery,
                    request.completedAt,
                    request.result,
                );
                if (request.disableEndpoint === true) {
                    await client.query(
                        `
              UPDATE webhook_endpoints
              SET status = 'disabled', disabled_at = $2, updated_at = $2
              WHERE endpoint_id = $1 AND status = 'enabled'
            `,
                        [delivery.endpoint_id, request.completedAt],
                    );
                    await insertEndpointAudit(client, {
                        auditId: createAuditId(),
                        endpointId: delivery.endpoint_id,
                        ownerId: delivery.caller_id,
                        actorId: "webhook-worker",
                        action:
                            failedResult?.errorCode === "TARGET_REJECTED"
                                ? "delivery_target_rejected"
                                : "disabled",
                        reasonCode:
                            failedResult?.errorCode === "TARGET_REJECTED"
                                ? failedResult.targetRejectionCode
                                : "HTTP_410",
                        createdAt: request.completedAt,
                    });
                }
                return true;
            });
        },

        reschedule: async (request) => {
            if (!isUuid(request.deliveryId) || !isUuid(request.claimToken)) {
                return false;
            }
            validateSendResult(request.result);
            const completedTime = timestampMilliseconds(request.completedAt);
            const nextAttemptTime = timestampMilliseconds(
                request.nextAttemptAt,
            );
            if (nextAttemptTime <= completedTime) {
                throw new Error(
                    "Webhook retry time must follow its completed Attempt",
                );
            }

            return transaction(options.pool, async (client) => {
                const selected = await client.query<DeliveryRow>(
                    `
            SELECT *
            FROM webhook_deliveries
            WHERE delivery_id = $1
            FOR UPDATE
          `,
                    [request.deliveryId],
                );
                const delivery = selected.rows[0];
                if (
                    delivery?.status !== "delivering" ||
                    delivery.claim_token !== request.claimToken
                ) {
                    return false;
                }
                const updated = await client.query(
                    `
            UPDATE webhook_deliveries
            SET
              status = 'pending',
              claim_token = NULL,
              claim_expires_at = NULL,
              next_attempt_at = $3,
              last_http_status = $4,
              last_error_code = $5,
              updated_at = $2,
              completed_at = NULL
            WHERE
              delivery_id = $1
              AND status = 'delivering'
              AND claim_token = $6
          `,
                    [
                        request.deliveryId,
                        request.completedAt,
                        request.nextAttemptAt,
                        request.result.httpStatus ?? null,
                        request.result.errorCode,
                        request.claimToken,
                    ],
                );
                if (updated.rowCount !== 1) return false;
                await recordAttempt(
                    client,
                    delivery,
                    request.completedAt,
                    request.result,
                    request.nextAttemptAt,
                );
                await client.query(
                    `
            INSERT INTO outbox_messages (
              message_id,
              event_id,
              topic,
              payload,
              created_at,
              available_at
            )
            VALUES ($1, $2, 'webhook-deliveries', $3::jsonb, $4, $5)
          `,
                    [
                        createOutboxMessageId(),
                        delivery.event_id,
                        JSON.stringify({
                            schemaVersion: 1,
                            deliveryId: request.deliveryId,
                        }),
                        request.completedAt,
                        request.nextAttemptAt,
                    ],
                );
                return true;
            });
        },

        findByRun: async (request) => {
            assertOwner(request.ownerId);
            if (request.runIds.length > 100) {
                throw new Error(
                    "Webhook Delivery lookup must not exceed 100 Run IDs",
                );
            }
            if (request.runIds.some((runId) => !isUuid(runId))) return [];
            if (request.runIds.length === 0) return [];
            const result = await options.pool.query<DeliveryRow>(
                `
          SELECT *
          FROM webhook_deliveries
          WHERE caller_id = $1 AND run_id = ANY($2::uuid[])
          ORDER BY created_at, delivery_id
        `,
                [request.ownerId, request.runIds],
            );
            return result.rows.map(deliveryFromRow);
        },

        findByEvent: async (request) => {
            assertOwner(request.ownerId);
            validateUuidList(request.eventIds, "Webhook Event lookup");
            if (request.eventIds.some((eventId) => !isUuid(eventId))) return [];
            if (request.eventIds.length === 0) return [];
            const result = await options.pool.query<DeliveryRow>(
                `
          SELECT *
          FROM webhook_deliveries
          WHERE caller_id = $1 AND event_id = ANY($2::uuid[])
          ORDER BY created_at, delivery_id
        `,
                [request.ownerId, request.eventIds],
            );
            return result.rows.map(deliveryFromRow);
        },

        findByEndpoint: async (request) => {
            assertOwner(request.ownerId);
            if (!isUuid(request.endpointId)) return [];
            const limit = boundedInteger(
                request.limit ?? 100,
                1,
                100,
                "Webhook Endpoint Delivery lookup limit",
            );
            const result = await options.pool.query<DeliveryRow>(
                `
          SELECT *
          FROM webhook_deliveries
          WHERE caller_id = $1 AND endpoint_id = $2
          ORDER BY created_at DESC, delivery_id DESC
          LIMIT $3
        `,
                [request.ownerId, request.endpointId, limit],
            );
            return result.rows.map(deliveryFromRow);
        },

        findAttempts: async (request) => {
            assertOwner(request.ownerId);
            if (!isUuid(request.deliveryId)) return [];
            const result = await options.pool.query<AttemptRow>(
                `
          SELECT
            attempts.*,
            deliveries.event_id,
            deliveries.run_id,
            deliveries.endpoint_id
          FROM webhook_delivery_attempts AS attempts
          JOIN webhook_deliveries AS deliveries
            ON deliveries.delivery_id = attempts.delivery_id
          WHERE
            deliveries.delivery_id = $1
            AND deliveries.caller_id = $2
          ORDER BY attempts.attempt_number
        `,
                [request.deliveryId, request.ownerId],
            );
            return result.rows.map(attemptFromRow);
        },

        replay: async (request) => {
            assertOwner(request.ownerId);
            assertOwner(request.actorId);
            if (!isUuid(request.deliveryId)) return undefined;
            timestampMilliseconds(request.replayedAt);

            return transaction(options.pool, async (client) => {
                const selected = await client.query<
                    DeliveryRow & { endpoint_status: string }
                >(
                    `
            SELECT deliveries.*, endpoints.status AS endpoint_status
            FROM webhook_deliveries AS deliveries
            JOIN webhook_endpoints AS endpoints
              ON endpoints.endpoint_id = deliveries.endpoint_id
            WHERE
              deliveries.delivery_id = $1
              AND deliveries.caller_id = $2
            FOR UPDATE OF deliveries
          `,
                    [request.deliveryId, request.ownerId],
                );
                const source = selected.rows[0];
                if (
                    !source ||
                    (source.status !== "failed" &&
                        source.status !== "exhausted") ||
                    source.endpoint_status !== "enabled"
                ) {
                    return undefined;
                }
                const siblings = await client.query<{ replay_number: number }>(
                    `
            SELECT replay_number
            FROM webhook_deliveries
            WHERE event_id = $1 AND endpoint_id = $2
            FOR UPDATE
          `,
                    [source.event_id, source.endpoint_id],
                );
                const replayNumber =
                    Math.max(
                        ...siblings.rows.map((row) => row.replay_number),
                        0,
                    ) + 1;
                const replayDeliveryId = createDeliveryId();
                const inserted = await client.query<DeliveryRow>(
                    `
            INSERT INTO webhook_deliveries (
              delivery_id,
              event_id,
              endpoint_id,
              run_id,
              caller_id,
              event_type,
              payload,
              next_attempt_at,
              created_at,
              updated_at,
              replay_number,
              replay_of_delivery_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8, $9, $10)
            RETURNING *
          `,
                    [
                        replayDeliveryId,
                        source.event_id,
                        source.endpoint_id,
                        source.run_id,
                        source.caller_id,
                        source.event_type,
                        source.payload,
                        request.replayedAt,
                        replayNumber,
                        source.delivery_id,
                    ],
                );
                await client.query(
                    `
            INSERT INTO outbox_messages (
              message_id,
              event_id,
              topic,
              payload,
              created_at,
              available_at
            )
            VALUES ($1, $2, 'webhook-deliveries', $3::jsonb, $4, $4)
          `,
                    [
                        createOutboxMessageId(),
                        source.event_id,
                        JSON.stringify({
                            schemaVersion: 1,
                            deliveryId: replayDeliveryId,
                        }),
                        request.replayedAt,
                    ],
                );
                await client.query(
                    `
            INSERT INTO webhook_delivery_replays (
              replay_id,
              source_delivery_id,
              replay_delivery_id,
              caller_id,
              actor_id,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
                    [
                        createReplayId(),
                        source.delivery_id,
                        replayDeliveryId,
                        request.ownerId,
                        request.actorId,
                        request.replayedAt,
                    ],
                );
                const row = inserted.rows[0];
                if (!row)
                    throw new Error(
                        "Webhook replay Delivery was not persisted",
                    );
                return deliveryFromRow(row);
            });
        },

        ready: async () => {
            const result = await options.pool.query<{
                endpoints: string | null;
                deliveries: string | null;
                replays: string | null;
                endpointAudits: string | null;
            }>(`
        SELECT
          to_regclass('public.webhook_endpoints')::text AS endpoints,
          to_regclass('public.webhook_deliveries')::text AS deliveries,
          to_regclass('public.webhook_delivery_replays')::text AS replays,
          to_regclass('public.webhook_endpoint_audit_events')::text
            AS "endpointAudits"
      `);
            if (
                result.rows[0]?.endpoints !== "webhook_endpoints" ||
                result.rows[0]?.deliveries !== "webhook_deliveries" ||
                result.rows[0]?.replays !== "webhook_delivery_replays" ||
                result.rows[0]?.endpointAudits !==
                    "webhook_endpoint_audit_events"
            ) {
                throw new Error(
                    "Webhook Delivery database migration is not ready",
                );
            }
        },
    });
}

interface EndpointRow extends QueryResultRow {
    endpoint_id: string;
    caller_id: string;
    url: string;
    status: "enabled" | "disabled";
    created_at: Date;
    updated_at: Date;
    disabled_at: Date | null;
}

interface EndpointAuditRow extends QueryResultRow {
    audit_id: string;
    endpoint_id: string;
    caller_id: string;
    actor_id: string;
    action: WebhookEndpointAuditView["action"];
    reason_code: string | null;
    created_at: Date;
}

interface DeliveryRow extends QueryResultRow {
    delivery_id: string;
    event_id: string;
    endpoint_id: string;
    run_id: string;
    caller_id: string;
    event_type: "process_run.succeeded" | "process_run.failed";
    payload: string;
    status: "pending" | "delivering" | "succeeded" | "failed" | "exhausted";
    attempt_count: number;
    claim_token: string | null;
    updated_at: Date;
    created_at: Date;
    completed_at: Date | null;
    last_http_status: number | null;
    last_error_code: string | null;
    replay_number: number;
    replay_of_delivery_id: string | null;
}

interface ClaimedDeliveryRow extends QueryResultRow {
    delivery_id: string;
    event_id: string;
    endpoint_id: string;
    payload: string;
    claim_token: string;
    attempt_count: number;
    created_at: Date;
    url: string;
    current_secret_envelope: string;
    previous_secret_envelope: string | null;
}

interface AttemptRow extends QueryResultRow {
    delivery_id: string;
    event_id: string;
    run_id: string;
    endpoint_id: string;
    attempt_number: number;
    started_at: Date;
    finished_at: Date | null;
    outcome: "started" | "succeeded" | "failed";
    http_status: number | null;
    latency_ms: number | null;
    error_code: string | null;
    next_attempt_at: Date | null;
}

function endpointFromRow(row: EndpointRow): WebhookEndpointView {
    return Object.freeze({
        endpointId: row.endpoint_id,
        ownerId: row.caller_id,
        url: row.url,
        status: row.status,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        ...(row.disabled_at ? { disabledAt: iso(row.disabled_at) } : {}),
    });
}

function endpointAuditFromRow(row: EndpointAuditRow): WebhookEndpointAuditView {
    return Object.freeze({
        auditId: row.audit_id,
        endpointId: row.endpoint_id,
        ownerId: row.caller_id,
        actorId: row.actor_id,
        action: row.action,
        ...(row.reason_code ? { reasonCode: row.reason_code } : {}),
        createdAt: iso(row.created_at),
    });
}

function deliveryFromRow(row: DeliveryRow): WebhookDeliveryView {
    return Object.freeze({
        deliveryId: row.delivery_id,
        eventId: row.event_id,
        endpointId: row.endpoint_id,
        runId: row.run_id,
        eventType: row.event_type,
        status: row.status,
        attemptCount: row.attempt_count,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
        ...(row.last_http_status === null
            ? {}
            : { lastHttpStatus: row.last_http_status }),
        ...(row.last_error_code === null
            ? {}
            : { lastErrorCode: row.last_error_code }),
        replayNumber: row.replay_number,
        ...(row.replay_of_delivery_id
            ? { replayOfDeliveryId: row.replay_of_delivery_id }
            : {}),
    });
}

function attemptFromRow(row: AttemptRow): WebhookDeliveryAttemptView {
    return Object.freeze({
        deliveryId: row.delivery_id,
        eventId: row.event_id,
        runId: row.run_id,
        endpointId: row.endpoint_id,
        attemptNumber: row.attempt_number,
        outcome: row.outcome,
        startedAt: iso(row.started_at),
        ...(row.finished_at === null
            ? {}
            : { finishedAt: iso(row.finished_at) }),
        ...(row.latency_ms === null ? {} : { latencyMs: row.latency_ms }),
        ...(row.http_status === null ? {} : { httpStatus: row.http_status }),
        ...(row.error_code === null ? {} : { errorCode: row.error_code }),
        ...(row.next_attempt_at === null
            ? {}
            : { nextAttemptAt: iso(row.next_attempt_at) }),
    });
}

function claimedDeliveryFromRow(
    row: ClaimedDeliveryRow,
    secretCipher: WebhookSecretCipher,
): ClaimedWebhookDelivery {
    return Object.freeze({
        deliveryId: row.delivery_id,
        eventId: row.event_id,
        endpointId: row.endpoint_id,
        endpointUrl: row.url,
        secrets: Object.freeze([
            secretCipher.decrypt(row.current_secret_envelope, row.endpoint_id),
            ...(row.previous_secret_envelope
                ? [
                      secretCipher.decrypt(
                          row.previous_secret_envelope,
                          row.endpoint_id,
                      ),
                  ]
                : []),
        ]),
        payload: row.payload,
        claimToken: row.claim_token,
        attemptNumber: row.attempt_count,
        createdAt: iso(row.created_at),
    });
}

async function transaction<Result>(
    pool: Pool,
    operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await operation(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch {
            // Preserve the original operation or commit error.
        }
        throw error;
    } finally {
        client.release();
    }
}

async function insertEndpointAudit(
    database: Pick<Pool | PoolClient, "query">,
    event: {
        auditId: string;
        endpointId: string;
        ownerId: string;
        actorId: string;
        action: WebhookEndpointAuditView["action"];
        reasonCode?: string;
        createdAt: string;
    },
): Promise<void> {
    await database.query(
        `
      INSERT INTO webhook_endpoint_audit_events (
        audit_id,
        endpoint_id,
        caller_id,
        actor_id,
        action,
        reason_code,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
        [
            event.auditId,
            event.endpointId,
            event.ownerId,
            event.actorId,
            event.action,
            event.reasonCode ?? null,
            event.createdAt,
        ],
    );
}

async function recordAttempt(
    client: PoolClient,
    delivery: DeliveryRow,
    completedAt: string,
    result: Parameters<WebhookDeliveryStore["complete"]>[0]["result"],
    nextAttemptAt?: string,
): Promise<void> {
    const updated = await client.query(
        `
      UPDATE webhook_delivery_attempts
      SET
        finished_at = $3,
        outcome = $4,
        http_status = $5,
        latency_ms = $6,
        error_code = $7,
        next_attempt_at = $8
      WHERE
        delivery_id = $1
        AND attempt_number = $2
        AND outcome = 'started'
    `,
        [
            delivery.delivery_id,
            delivery.attempt_count,
            completedAt,
            result.outcome,
            result.httpStatus ?? null,
            result.latencyMs,
            result.outcome === "failed"
                ? (result.targetRejectionCode ?? result.errorCode)
                : null,
            nextAttemptAt ?? null,
        ],
    );
    if (updated.rowCount !== 1) {
        throw new Error(
            "Webhook Delivery Attempt was not started by its claim",
        );
    }
}

function validateSendResult(
    result: Parameters<WebhookDeliveryStore["complete"]>[0]["result"],
): void {
    if (!Number.isSafeInteger(result.latencyMs) || result.latencyMs < 0) {
        throw new Error("Webhook Delivery latency is invalid");
    }
    if (
        result.httpStatus !== undefined &&
        (!Number.isInteger(result.httpStatus) ||
            result.httpStatus < 100 ||
            result.httpStatus > 599)
    ) {
        throw new Error("Webhook Delivery HTTP status is invalid");
    }
    if (
        result.outcome === "failed" &&
        result.retryAfterMs !== undefined &&
        (!Number.isSafeInteger(result.retryAfterMs) || result.retryAfterMs < 0)
    ) {
        throw new Error("Webhook Delivery Retry-After is invalid");
    }
    if (
        result.outcome === "failed" &&
        result.errorCode === "TARGET_REJECTED" &&
        result.targetRejectionCode === undefined
    ) {
        throw new Error("Webhook target rejection reason is required");
    }
}

function assertOwner(value: string): void {
    const length = Buffer.byteLength(value, "utf8");
    if (length < 1 || length > 512) {
        throw new Error("Webhook owner is invalid");
    }
}

function assertUuid(value: string, label: string): void {
    if (!isUuid(value)) throw new Error(`${label} must be a UUID`);
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
    );
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}

function boundedInteger(
    value: number,
    minimum: number,
    maximum: number,
    label: string,
): number {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${label} must be between ${minimum} and ${maximum}`);
    }
    return value;
}

function validateUuidList(values: readonly string[], label: string): void {
    if (values.length > 100) {
        throw new Error(`${label} must not exceed 100 IDs`);
    }
}

function addMilliseconds(timestamp: string, durationMs: number): string {
    return new Date(
        timestampMilliseconds(timestamp) + durationMs,
    ).toISOString();
}

function timestampMilliseconds(timestamp: string): number {
    const value = new Date(timestamp).getTime();
    if (!Number.isFinite(value))
        throw new Error("Webhook timestamp is invalid");
    return value;
}

function iso(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new Error("Persisted Webhook timestamp is invalid");
    }
    return date.toISOString();
}
