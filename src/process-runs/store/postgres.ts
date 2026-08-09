import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
    AcceptedProcessInput,
    ProcessErrorCode,
} from "../../processes/runtime.js";
import type {
    ProcessRecoveryCandidate,
    ProcessRecoveryStore,
    ProcessRunRecoverySource,
} from "../recovery/index.js";
import type {
    ClaimedProcessRun,
    ProcessRunStore,
    StoredProcessRun,
} from "./index.js";
import { ProcessRunBacklogLimitError } from "./index.js";

export type PostgresProcessRunStoreRetention = Readonly<{
    acceptedInputMs: number;
    resultMs: number;
    metadataMs: number;
}>;

export type PostgresProcessRunAdmission = Readonly<{
    globalBacklogLimit: number;
    callerBacklogLimit: number;
    retryAfterSeconds: number;
}>;

export type PostgresProcessRunStore = ProcessRunStore &
    Readonly<{
        ready: () => Promise<void>;
    }>;

export function createPostgresProcessRunStore(options: {
    pool: Pool;
    retention: PostgresProcessRunStoreRetention;
    admission?: PostgresProcessRunAdmission;
    claimLeaseMs?: number;
    createEventId?: () => string;
    createOutboxMessageId?: () => string;
    createWebhookDeliveryId?: () => string;
}): PostgresProcessRunStore {
    const retention = validateRetention(options.retention);
    const admission = options.admission
        ? validateAdmission(options.admission)
        : undefined;
    const claimLeaseMs = positiveInteger(
        options.claimLeaseMs ?? 60_000,
        "Process Run claim lease",
    );
    const createEventId = options.createEventId ?? randomUUID;
    const createOutboxMessageId = options.createOutboxMessageId ?? randomUUID;
    const createWebhookDeliveryId =
        options.createWebhookDeliveryId ?? randomUUID;
    const recovery = createPostgresProcessRunRecoverySource({
        pool: options.pool,
    });

    return Object.freeze({
        accept: async (candidate) => {
            const acceptedInputJson = serializeJson(candidate.acceptedInput);
            const inputExpiresAt = addMilliseconds(
                candidate.createdAt,
                retention.acceptedInputMs,
            );
            const metadataExpiresAt = addMilliseconds(
                candidate.createdAt,
                retention.metadataMs,
            );

            return transaction(options.pool, async (client) => {
                if (admission) {
                    await client.query(
                        "SELECT pg_advisory_xact_lock(1886417, 230001)",
                    );
                    const existing = await findIdempotentRun(client, candidate);
                    if (existing) return existing;

                    const backlog = await client.query<{
                        global_count: number;
                        caller_count: number;
                    }>(
                        `
              SELECT
                count(*)::integer AS global_count,
                count(*) FILTER (WHERE caller_id = $1)::integer AS caller_count
              FROM process_runs
              WHERE status IN ('queued', 'running')
            `,
                        [candidate.ownerId],
                    );
                    const counts = backlog.rows[0];
                    if (!counts)
                        throw new Error(
                            "Process Run backlog count is unavailable",
                        );
                    if (counts.caller_count >= admission.callerBacklogLimit) {
                        throw new ProcessRunBacklogLimitError(
                            "caller",
                            admission.retryAfterSeconds,
                        );
                    }
                    if (counts.global_count >= admission.globalBacklogLimit) {
                        throw new ProcessRunBacklogLimitError(
                            "global",
                            admission.retryAfterSeconds,
                        );
                    }
                }

                const inserted = await client.query<ProcessRunRow>(
                    `
            INSERT INTO process_runs (
              run_id,
              caller_id,
              idempotency_key,
              request_fingerprint,
              process_id,
              process_version,
              status,
              accepted_input,
              created_at,
              updated_at,
              input_expires_at,
              metadata_expires_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7::jsonb, $8, $8, $9, $10)
            ON CONFLICT (caller_id, idempotency_key) DO NOTHING
            RETURNING *
          `,
                    [
                        candidate.runId,
                        candidate.ownerId,
                        candidate.idempotencyKey,
                        candidate.requestFingerprint,
                        candidate.process,
                        candidate.version,
                        acceptedInputJson,
                        candidate.createdAt,
                        inputExpiresAt,
                        metadataExpiresAt,
                    ],
                );

                const row = inserted.rows[0];
                if (!row) {
                    const existing = await client.query<ProcessRunRow>(
                        `
              SELECT *
              FROM process_runs
              WHERE caller_id = $1 AND idempotency_key = $2
            `,
                        [candidate.ownerId, candidate.idempotencyKey],
                    );
                    const existingRow = existing.rows[0];
                    if (!existingRow) {
                        throw new Error(
                            "Process Run idempotency conflict could not be resolved",
                        );
                    }
                    const existingRun = processRunFromRow(existingRow);
                    return existingRun.requestFingerprint ===
                        candidate.requestFingerprint
                        ? { outcome: "replayed", run: existingRun }
                        : { outcome: "conflict" };
                }

                const run = processRunFromRow(row);
                const eventId = createEventId();
                const messageId = createOutboxMessageId();
                const eventPayload = serializeJson({
                    schemaVersion: 1,
                    eventId,
                    type: "process_run.queued",
                    createdAt: run.createdAt,
                    data: {
                        runId: run.runId,
                        process: run.process,
                        version: run.version,
                        status: "queued",
                    },
                });
                await client.query(
                    `
            INSERT INTO process_events (
              event_id,
              run_id,
              event_type,
              deduplication_key,
              payload,
              created_at
            )
            VALUES ($1, $2, 'process_run.queued', $3, $4::jsonb, $5)
          `,
                    [
                        eventId,
                        run.runId,
                        `process-run:${run.runId}:queued:0`,
                        eventPayload,
                        run.createdAt,
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
            VALUES ($1, $2, 'process-runs', $3::jsonb, $4, $4)
          `,
                    [
                        messageId,
                        eventId,
                        serializeJson({ schemaVersion: 1, runId: run.runId }),
                        run.createdAt,
                    ],
                );
                return { outcome: "created", run };
            });
        },

        findOwned: async (runId, ownerId) => {
            if (!isUuid(runId)) return undefined;
            const result = await options.pool.query<ProcessRunRow>(
                `
          SELECT *
          FROM process_runs
          WHERE run_id = $1 AND caller_id = $2
        `,
                [runId, ownerId],
            );
            const row = result.rows[0];
            return row ? processRunFromRow(row) : undefined;
        },

        claim: async (request) => {
            if (!isUuid(request.runId) || !isUuid(request.claimToken)) {
                return undefined;
            }
            const claimExpiresAt = addMilliseconds(
                request.claimedAt,
                claimLeaseMs,
            );

            return transaction(options.pool, async (client) => {
                const selected = await client.query<ProcessRunRow>(
                    "SELECT * FROM process_runs WHERE run_id = $1 FOR UPDATE",
                    [request.runId],
                );
                const candidate = selected.rows[0];
                if (
                    !candidate ||
                    (candidate.status !== "queued" &&
                        (candidate.status !== "running" ||
                            !candidate.claim_expires_at ||
                            candidate.claim_expires_at.getTime() >
                                timestampMilliseconds(request.claimedAt)))
                ) {
                    return undefined;
                }

                if (candidate.status === "running") {
                    const abandoned = await client.query(
                        `
              UPDATE process_run_attempts
              SET
                status = 'abandoned',
                finished_at = $4,
                result_code = 'CLAIM_EXPIRED'
              WHERE
                run_id = $1
                AND attempt_number = $2
                AND claim_token = $3
                AND status = 'running'
            `,
                        [
                            candidate.run_id,
                            candidate.attempt_count,
                            candidate.claim_token,
                            request.claimedAt,
                        ],
                    );
                    if (abandoned.rowCount !== 1) {
                        throw new Error(
                            "Expired Process Run Attempt is inconsistent",
                        );
                    }
                }

                const claimed = await client.query<ProcessRunRow>(
                    `
            UPDATE process_runs
            SET
              status = 'running',
              claim_token = $2,
              claim_expires_at = $4,
              started_at = COALESCE(started_at, $3),
              updated_at = $3,
              attempt_count = attempt_count + 1,
              revision = revision + 1
            WHERE run_id = $1
            RETURNING *
          `,
                    [
                        request.runId,
                        request.claimToken,
                        request.claimedAt,
                        claimExpiresAt,
                    ],
                );
                const row = claimed.rows[0];
                if (!row) return undefined;

                await client.query(
                    `
            INSERT INTO process_run_attempts (
              run_id,
              attempt_number,
              claim_token,
              status,
              started_at
            )
            VALUES ($1, $2, $3, 'running', $4)
          `,
                    [
                        row.run_id,
                        row.attempt_count,
                        request.claimToken,
                        request.claimedAt,
                    ],
                );
                return claimedProcessRunFromRow(row);
            });
        },

        complete: async (request) => {
            if (!isUuid(request.runId) || !isUuid(request.claimToken))
                return false;
            const completion = request.completion;
            const outputJson =
                completion.status === "succeeded"
                    ? serializeJson(completion.output)
                    : undefined;
            const errorCode =
                completion.status === "failed"
                    ? completion.error.code
                    : undefined;
            const errorMessage =
                completion.status === "failed"
                    ? completion.error.message
                    : undefined;
            const resultExpiresAt = addMilliseconds(
                request.completedAt,
                retention.resultMs,
            );

            return transaction(options.pool, async (client) => {
                const completed = await client.query<
                    Pick<
                        ProcessRunRow,
                        | "attempt_count"
                        | "caller_id"
                        | "process_id"
                        | "process_version"
                    >
                >(
                    `
            UPDATE process_runs
            SET
              status = $3,
              output = CASE
                WHEN $3 = 'succeeded' THEN $5::jsonb
                ELSE NULL
              END,
              error_code = $6,
              public_error_message = $7,
              claim_token = NULL,
              claim_expires_at = NULL,
              finished_at = $4,
              updated_at = $4,
              result_expires_at = $8,
              revision = revision + 1
            WHERE
              run_id = $1
              AND status = 'running'
              AND claim_token = $2
            RETURNING attempt_count, caller_id, process_id, process_version
          `,
                    [
                        request.runId,
                        request.claimToken,
                        completion.status,
                        request.completedAt,
                        outputJson,
                        errorCode,
                        errorMessage,
                        resultExpiresAt,
                    ],
                );
                const row = completed.rows[0];
                if (!row) return false;

                const attemptStatus =
                    completion.status === "succeeded" ? "succeeded" : "failed";
                const attempt = await client.query(
                    `
            UPDATE process_run_attempts
            SET status = $4, finished_at = $5, result_code = $6
            WHERE
              run_id = $1
              AND attempt_number = $2
              AND claim_token = $3
              AND status = 'running'
          `,
                    [
                        request.runId,
                        row.attempt_count,
                        request.claimToken,
                        attemptStatus,
                        request.completedAt,
                        completion.status === "succeeded"
                            ? "SUCCEEDED"
                            : errorCode,
                    ],
                );
                if (attempt.rowCount !== 1) {
                    throw new Error(
                        "Process Run Attempt state is inconsistent",
                    );
                }

                const eventId = createEventId();
                const eventType = `process_run.${completion.status}` as const;
                const payload = serializeJson({
                    schemaVersion: 1,
                    eventId,
                    type: eventType,
                    createdAt: request.completedAt,
                    data: {
                        runId: request.runId,
                        process: row.process_id,
                        version: row.process_version,
                        status: completion.status,
                        resultLocation: `/process-runs/${request.runId}`,
                    },
                });
                await client.query(
                    `
            INSERT INTO process_events (
              event_id,
              run_id,
              event_type,
              deduplication_key,
              payload,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5::jsonb, $6)
          `,
                    [
                        eventId,
                        request.runId,
                        eventType,
                        `process-run:${request.runId}:${completion.status}`,
                        payload,
                        request.completedAt,
                    ],
                );
                const endpoints = await client.query<{ endpoint_id: string }>(
                    `
            SELECT endpoint_id
            FROM webhook_endpoints
            WHERE caller_id = $1 AND status = 'enabled'
            ORDER BY endpoint_id
          `,
                    [row.caller_id],
                );
                for (const endpoint of endpoints.rows) {
                    const deliveryId = createWebhookDeliveryId();
                    await client.query(
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
                updated_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8)
            `,
                        [
                            deliveryId,
                            eventId,
                            endpoint.endpoint_id,
                            request.runId,
                            row.caller_id,
                            eventType,
                            payload,
                            request.completedAt,
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
                            eventId,
                            serializeJson({ schemaVersion: 1, deliveryId }),
                            request.completedAt,
                        ],
                    );
                }
                return true;
            });
        },

        scheduleRetry: async (request) => {
            if (!isUuid(request.runId) || !isUuid(request.claimToken))
                return false;
            timestampMilliseconds(request.scheduledAt);

            return transaction(options.pool, async (client) => {
                const retried = await client.query<
                    Pick<
                        ProcessRunRow,
                        "attempt_count" | "process_id" | "process_version"
                    >
                >(
                    `
            UPDATE process_runs
            SET
              status = 'queued',
              claim_token = NULL,
              claim_expires_at = NULL,
              updated_at = $3,
              revision = revision + 1
            WHERE
              run_id = $1
              AND status = 'running'
              AND claim_token = $2
            RETURNING attempt_count, process_id, process_version
          `,
                    [request.runId, request.claimToken, request.scheduledAt],
                );
                const row = retried.rows[0];
                if (!row) return false;

                const attempt = await client.query(
                    `
            UPDATE process_run_attempts
            SET status = 'failed', finished_at = $4, result_code = $5
            WHERE
              run_id = $1
              AND attempt_number = $2
              AND claim_token = $3
              AND status = 'running'
          `,
                    [
                        request.runId,
                        row.attempt_count,
                        request.claimToken,
                        request.scheduledAt,
                        request.failure.code,
                    ],
                );
                if (attempt.rowCount !== 1) {
                    throw new Error(
                        "Retried Process Run Attempt is inconsistent",
                    );
                }

                const eventId = createEventId();
                await client.query(
                    `
            INSERT INTO process_events (
              event_id,
              run_id,
              event_type,
              deduplication_key,
              payload,
              created_at
            )
            VALUES ($1, $2, 'process_run.queued', $3, $4::jsonb, $5)
          `,
                    [
                        eventId,
                        request.runId,
                        `process-run:${request.runId}:queued:${row.attempt_count}`,
                        serializeJson({
                            schemaVersion: 1,
                            eventId,
                            type: "process_run.queued",
                            createdAt: request.scheduledAt,
                            data: {
                                runId: request.runId,
                                process: row.process_id,
                                version: row.process_version,
                                status: "queued",
                            },
                        }),
                        request.scheduledAt,
                    ],
                );
                return true;
            });
        },

        releaseClaim: async (request) => {
            if (!isUuid(request.runId) || !isUuid(request.claimToken))
                return false;
            timestampMilliseconds(request.releasedAt);

            return transaction(options.pool, async (client) => {
                const released = await client.query<
                    Pick<ProcessRunRow, "attempt_count">
                >(
                    `
            UPDATE process_runs
            SET
              status = 'queued',
              claim_token = NULL,
              claim_expires_at = NULL,
              updated_at = $3,
              revision = revision + 1
            WHERE
              run_id = $1
              AND status = 'running'
              AND claim_token = $2
            RETURNING attempt_count
          `,
                    [request.runId, request.claimToken, request.releasedAt],
                );
                const row = released.rows[0];
                if (!row) return false;

                const attempt = await client.query(
                    `
            UPDATE process_run_attempts
            SET
              status = 'abandoned',
              finished_at = $4,
              result_code = 'CLAIM_RELEASED'
            WHERE
              run_id = $1
              AND attempt_number = $2
              AND claim_token = $3
              AND status = 'running'
          `,
                    [
                        request.runId,
                        row.attempt_count,
                        request.claimToken,
                        request.releasedAt,
                    ],
                );
                if (attempt.rowCount !== 1) {
                    throw new Error(
                        "Released Process Run Attempt is inconsistent",
                    );
                }
                return true;
            });
        },

        findRecoverable: recovery.findRecoverable,

        ready: async () => {
            const result = await options.pool.query<{
                process_runs: string | null;
                webhook_endpoints: string | null;
                admission_index: string | null;
            }>(`
        SELECT
          to_regclass('public.process_runs')::text AS process_runs,
          to_regclass('public.webhook_endpoints')::text AS webhook_endpoints,
          to_regclass('public.process_runs_caller_backlog_idx')::text AS admission_index
      `);
            if (
                result.rows[0]?.process_runs !== "process_runs" ||
                result.rows[0]?.webhook_endpoints !== "webhook_endpoints" ||
                result.rows[0]?.admission_index !==
                    "process_runs_caller_backlog_idx"
            ) {
                throw new Error("Process Run database migration is not ready");
            }
        },
    });
}

async function findIdempotentRun(
    client: PoolClient,
    candidate: Readonly<{
        ownerId: string;
        idempotencyKey: string;
        requestFingerprint: string;
    }>,
) {
    const existing = await client.query<ProcessRunRow>(
        `
      SELECT *
      FROM process_runs
      WHERE caller_id = $1 AND idempotency_key = $2
    `,
        [candidate.ownerId, candidate.idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row) return undefined;
    const run = processRunFromRow(row);
    return run.requestFingerprint === candidate.requestFingerprint
        ? ({ outcome: "replayed", run } as const)
        : ({ outcome: "conflict" } as const);
}

export function createPostgresProcessRunRecoverySource(options: {
    pool: Pool;
}): ProcessRunRecoverySource &
    ProcessRecoveryStore &
    Readonly<{ ready: () => Promise<void> }> {
    return Object.freeze({
        findRecoverable: async (request) => {
            const limit = recoveryLimit(request.limit);
            timestampMilliseconds(request.asOf);
            timestampMilliseconds(request.queuedBefore);
            const result = await options.pool.query<{ run_id: string }>(
                `
          SELECT run_id
          FROM process_runs
          WHERE
            (status = 'queued' AND updated_at <= $1)
            OR (status = 'running' AND claim_expires_at <= $2)
          ORDER BY
            CASE
              WHEN status = 'running' THEN claim_expires_at
              ELSE updated_at
            END,
            run_id
          LIMIT $3
        `,
                [request.queuedBefore, request.asOf, limit],
            );
            return result.rows.map((row) =>
                Object.freeze({ runId: row.run_id }),
            );
        },

        beginRecovery: async (request) => {
            assertUuid(request.recoveryId, "Process Recovery ID");
            assertOwner(request.actorId, "Process Recovery actor");
            timestampMilliseconds(request.asOf);
            timestampMilliseconds(request.queuedBefore);
            timestampMilliseconds(request.startedAt);
            if (request.cursor !== undefined) {
                assertUuid(request.cursor, "Process Recovery cursor");
            }
            await options.pool.query(
                `
          INSERT INTO queue_recovery_runs (
            recovery_id,
            trigger_kind,
            recovery_mode,
            dry_run,
            actor_id,
            as_of,
            queued_before,
            cursor_run_id,
            started_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
                [
                    request.recoveryId,
                    request.trigger,
                    request.mode,
                    request.dryRun,
                    request.actorId,
                    request.asOf,
                    request.queuedBefore,
                    request.cursor ?? null,
                    request.startedAt,
                ],
            );
        },

        findRecoveryCandidates: async (request) => {
            const limit = recoveryLimit(request.limit);
            const asOfMs = timestampMilliseconds(request.asOf);
            const queuedBeforeMs = timestampMilliseconds(request.queuedBefore);
            if (request.cursor !== undefined) {
                assertUuid(request.cursor, "Process Recovery cursor");
            }
            const result = await options.pool.query<RecoveryCandidateRow>(
                `
          SELECT
            runs.run_id,
            runs.status,
            runs.updated_at,
            runs.claim_expires_at,
            EXISTS (
              SELECT 1
              FROM process_events AS events
              JOIN outbox_messages AS messages
                ON messages.event_id = events.event_id
              WHERE
                events.run_id = runs.run_id
                AND messages.topic = 'process-runs'
                AND messages.published_at IS NULL
            ) AS pending_outbox
          FROM process_runs AS runs
          WHERE
            runs.status IN ('queued', 'running')
            AND ($3::uuid IS NULL OR runs.run_id > $3)
            AND (
              $4 = 'all'
              OR (runs.status = 'queued' AND runs.updated_at <= $2)
              OR (
                runs.status = 'running'
                AND runs.claim_expires_at <= $1
              )
            )
          ORDER BY runs.run_id
          LIMIT $5
        `,
                [
                    request.asOf,
                    request.queuedBefore,
                    request.cursor ?? null,
                    request.mode,
                    limit + 1,
                ],
            );
            const hasMore = result.rows.length > limit;
            const selected = result.rows.slice(0, limit);
            const candidates = selected.map((row): ProcessRecoveryCandidate => {
                if (row.status === "queued") {
                    return Object.freeze({
                        runId: row.run_id,
                        status: "queued",
                        reason:
                            row.updated_at.getTime() <= queuedBeforeMs
                                ? "stuck_queued"
                                : "recent_queued",
                        pendingOutbox: row.pending_outbox,
                    });
                }
                if (row.status !== "running" || !row.claim_expires_at) {
                    throw new Error(
                        "Persisted recovery candidate is inconsistent",
                    );
                }
                return Object.freeze({
                    runId: row.run_id,
                    status: "running",
                    reason:
                        row.claim_expires_at.getTime() <= asOfMs
                            ? "expired_lease"
                            : "active_lease",
                    pendingOutbox: row.pending_outbox,
                });
            });
            const last = candidates.at(-1);
            return Object.freeze({
                candidates: Object.freeze(candidates),
                ...(hasMore && last ? { nextCursor: last.runId } : {}),
            });
        },

        acknowledgePendingOutbox: async (request) => {
            assertUuid(request.runId, "Process Run ID");
            timestampMilliseconds(request.acknowledgedAt);
            const result = await options.pool.query(
                `
          UPDATE outbox_messages AS messages
          SET
            published_at = $2,
            claim_token = NULL,
            claim_expires_at = NULL
          FROM process_events AS events
          WHERE
            messages.event_id = events.event_id
            AND events.run_id = $1
            AND messages.topic = 'process-runs'
            AND messages.published_at IS NULL
            AND (
              messages.claim_token IS NULL
              OR messages.claim_expires_at <= $2
            )
        `,
                [request.runId, request.acknowledgedAt],
            );
            return result.rowCount ?? 0;
        },

        recordRecoveryItem: async (request) => {
            assertUuid(request.recoveryId, "Process Recovery ID");
            assertUuid(request.item.runId, "Process Run ID");
            timestampMilliseconds(request.recordedAt);
            await options.pool.query(
                `
          INSERT INTO queue_recovery_items (
            recovery_id,
            run_id,
            run_status,
            reason,
            pending_outbox,
            queue_state,
            action,
            outbox_action,
            recorded_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
                [
                    request.recoveryId,
                    request.item.runId,
                    request.item.status,
                    request.item.reason,
                    request.item.pendingOutbox,
                    request.item.queueState,
                    request.item.action,
                    request.item.outboxAction,
                    request.recordedAt,
                ],
            );
        },

        completeRecovery: async (request) => {
            assertUuid(request.recoveryId, "Process Recovery ID");
            if (request.nextCursor !== undefined) {
                assertUuid(request.nextCursor, "Process Recovery cursor");
            }
            timestampMilliseconds(request.completedAt);
            const counters = request.counters;
            const result = await options.pool.query(
                `
          UPDATE queue_recovery_runs
          SET
            next_cursor_run_id = $2,
            status = 'completed',
            candidate_count = $3,
            missing_job_count = $4,
            existing_job_count = $5,
            terminal_job_count = $6,
            invalid_job_count = $7,
            active_lease_count = $8,
            pending_outbox_count = $9,
            enqueued_count = $10,
            duplicate_count = $11,
            outbox_acknowledged_count = $12,
            failed_count = $13,
            completed_at = $14
          WHERE recovery_id = $1 AND status = 'running'
        `,
                [
                    request.recoveryId,
                    request.nextCursor ?? null,
                    counters.found,
                    counters.missingJobs,
                    counters.existingJobs,
                    counters.terminalJobs,
                    counters.invalidJobs,
                    counters.activeLeases,
                    counters.pendingOutbox,
                    counters.enqueued,
                    counters.duplicates,
                    counters.outboxAcknowledged,
                    counters.failed,
                    request.completedAt,
                ],
            );
            if (result.rowCount !== 1) {
                throw new Error("Process Recovery audit is not running");
            }
        },

        failRecovery: async (request) => {
            assertUuid(request.recoveryId, "Process Recovery ID");
            timestampMilliseconds(request.failedAt);
            await options.pool.query(
                `
          UPDATE queue_recovery_runs
          SET status = 'failed', error_code = $2, completed_at = $3
          WHERE recovery_id = $1 AND status = 'running'
        `,
                [request.recoveryId, request.errorCode, request.failedAt],
            );
        },

        ready: async () => {
            const result = await options.pool.query<{
                runs: string | null;
                recoveryRuns: string | null;
                recoveryItems: string | null;
            }>(`
        SELECT
          to_regclass('public.process_runs')::text AS runs,
          to_regclass('public.queue_recovery_runs')::text AS "recoveryRuns",
          to_regclass('public.queue_recovery_items')::text AS "recoveryItems"
      `);
            if (
                result.rows[0]?.runs !== "process_runs" ||
                result.rows[0]?.recoveryRuns !== "queue_recovery_runs" ||
                result.rows[0]?.recoveryItems !== "queue_recovery_items"
            ) {
                throw new Error(
                    "Process Recovery database migration is not ready",
                );
            }
        },
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
            // Preserve the operation or commit error that made the transaction fail.
        }
        throw error;
    } finally {
        client.release();
    }
}

interface ProcessRunRow extends QueryResultRow {
    schema_version: number;
    run_id: string;
    caller_id: string;
    idempotency_key: string;
    request_fingerprint: string;
    process_id: string;
    process_version: string;
    status: string;
    accepted_input: unknown;
    output: unknown;
    error_code: string | null;
    public_error_message: string | null;
    attempt_count: number;
    revision: string;
    claim_token: string | null;
    claim_expires_at: Date | null;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
    updated_at: Date;
    input_expired_at: Date | null;
    result_expired_at: Date | null;
}

interface RecoveryCandidateRow extends QueryResultRow {
    run_id: string;
    status: string;
    updated_at: Date;
    claim_expires_at: Date | null;
    pending_outbox: boolean;
}

function processRunFromRow(row: ProcessRunRow): StoredProcessRun {
    if (row.schema_version !== 1) {
        throw new Error("Unsupported persisted Process Run schema version");
    }
    const acceptedInput =
        row.accepted_input === null
            ? undefined
            : (row.accepted_input as AcceptedProcessInput);
    const base = {
        schemaVersion: 1 as const,
        runId: row.run_id,
        ownerId: row.caller_id,
        idempotencyKey: row.idempotency_key,
        requestFingerprint: row.request_fingerprint,
        process: row.process_id,
        version: row.process_version,
        ...(acceptedInput === undefined
            ? {}
            : { acceptedInput: structuredClone(acceptedInput) }),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        attemptCount: row.attempt_count,
        revision: safeInteger(row.revision, "Process Run revision"),
    };
    switch (row.status) {
        case "queued": {
            if (!acceptedInput) {
                throw new Error(
                    "Persisted runnable Process Run input is unavailable",
                );
            }
            return {
                ...base,
                status: "queued",
                acceptedInput: structuredClone(acceptedInput),
                ...(row.started_at ? { startedAt: iso(row.started_at) } : {}),
            };
        }
        case "running": {
            if (
                !acceptedInput ||
                !row.claim_token ||
                !row.claim_expires_at ||
                !row.started_at
            ) {
                throw new Error(
                    "Persisted running Process Run is inconsistent",
                );
            }
            return {
                ...base,
                status: "running",
                acceptedInput: structuredClone(acceptedInput),
                claimToken: row.claim_token,
                claimExpiresAt: iso(row.claim_expires_at),
                startedAt: iso(row.started_at),
            };
        }
        case "succeeded":
            if (!row.started_at || !row.finished_at) {
                throw new Error(
                    "Persisted succeeded Process Run is inconsistent",
                );
            }
            return row.result_expired_at
                ? {
                      ...base,
                      status: "succeeded",
                      startedAt: iso(row.started_at),
                      finishedAt: iso(row.finished_at),
                      resultExpiredAt: iso(row.result_expired_at),
                  }
                : {
                      ...base,
                      status: "succeeded",
                      startedAt: iso(row.started_at),
                      finishedAt: iso(row.finished_at),
                      output: structuredClone(row.output),
                  };
        case "failed":
            if (!row.started_at || !row.finished_at) {
                throw new Error("Persisted failed Process Run is inconsistent");
            }
            if (row.result_expired_at) {
                return {
                    ...base,
                    status: "failed",
                    startedAt: iso(row.started_at),
                    finishedAt: iso(row.finished_at),
                    resultExpiredAt: iso(row.result_expired_at),
                };
            }
            if (
                !isProcessErrorCode(row.error_code) ||
                row.public_error_message === null
            ) {
                throw new Error("Persisted failed Process Run is inconsistent");
            }
            return {
                ...base,
                status: "failed",
                startedAt: iso(row.started_at),
                finishedAt: iso(row.finished_at),
                error: {
                    code: row.error_code,
                    message: row.public_error_message,
                },
            };
        default:
            throw new Error("Persisted Process Run status is unsupported");
    }
}

function claimedProcessRunFromRow(row: ProcessRunRow): ClaimedProcessRun {
    const run = processRunFromRow(row);
    if (run.status !== "running") {
        throw new Error("Claimed Process Run is not running");
    }
    return {
        runId: run.runId,
        process: run.process,
        version: run.version,
        acceptedInput: structuredClone(run.acceptedInput),
        claimToken: run.claimToken,
        attemptNumber: run.attemptCount,
    };
}

function validateRetention(
    retention: PostgresProcessRunStoreRetention,
): PostgresProcessRunStoreRetention {
    return Object.freeze({
        acceptedInputMs: positiveInteger(
            retention.acceptedInputMs,
            "Accepted Process input retention",
        ),
        resultMs: positiveInteger(
            retention.resultMs,
            "Process result retention",
        ),
        metadataMs: positiveInteger(
            retention.metadataMs,
            "Process metadata retention",
        ),
    });
}

function validateAdmission(
    admission: PostgresProcessRunAdmission,
): PostgresProcessRunAdmission {
    const globalBacklogLimit = positiveInteger(
        admission.globalBacklogLimit,
        "Global Process Run backlog limit",
    );
    const callerBacklogLimit = positiveInteger(
        admission.callerBacklogLimit,
        "Caller Process Run backlog limit",
    );
    if (callerBacklogLimit > globalBacklogLimit) {
        throw new Error(
            "Caller Process Run backlog limit must not exceed the global limit",
        );
    }
    return Object.freeze({
        globalBacklogLimit,
        callerBacklogLimit,
        retryAfterSeconds: positiveInteger(
            admission.retryAfterSeconds,
            "Process Run backlog Retry-After",
        ),
    });
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}

function recoveryLimit(value: number): number {
    const limit = positiveInteger(value, "Process Run recovery limit");
    if (limit > 100) {
        throw new Error("Process Run recovery limit must not exceed 100");
    }
    return limit;
}

function addMilliseconds(timestamp: string, durationMs: number): string {
    const time = timestampMilliseconds(timestamp);
    return new Date(time + durationMs).toISOString();
}

function timestampMilliseconds(timestamp: string): number {
    const time = new Date(timestamp).getTime();
    if (!Number.isFinite(time))
        throw new Error("Process Run timestamp is invalid");
    return time;
}

function serializeJson(value: unknown): string {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new Error("Process Run content must be JSON serializable");
    }
    return serialized;
}

function iso(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new Error("Persisted Process Run timestamp is invalid");
    }
    return date.toISOString();
}

function safeInteger(value: string | number, label: string): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
        throw new Error(`${label} is outside the supported range`);
    }
    return number;
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
    );
}

function assertUuid(value: string, label: string): void {
    if (!isUuid(value)) throw new Error(`${label} must be a UUID`);
}

function assertOwner(value: string, label: string): void {
    if (
        typeof value !== "string" ||
        value.trim().length === 0 ||
        Buffer.byteLength(value, "utf8") > 512
    ) {
        throw new Error(`${label} must be 1 to 512 UTF-8 bytes`);
    }
}

const processErrorCodes = new Set<ProcessErrorCode>([
    "AGENT_FAILURE",
    "DEPENDENCY_FAILURE",
    "INTERNAL_ERROR",
    "INVALID_INPUT",
    "INVALID_OUTPUT",
    "PROCESS_NOT_FOUND",
    "PROCESS_TIMEOUT",
]);

function isProcessErrorCode(value: string | null): value is ProcessErrorCode {
    return value !== null && processErrorCodes.has(value as ProcessErrorCode);
}
