import { randomUUID } from "node:crypto";

export type AsyncInternalSmokeBaseline = Readonly<{
    schemaVersion: 1;
    event: "async_internal_gateway_smoke_completed";
    revision: string;
    startedAt: string;
    completedAt: string;
    healthReady: true;
    ownerIsolationVerified: true;
    synchronousExecutionVerified: true;
    success: SmokeTerminalRun & Readonly<{ status: "succeeded" }>;
    failure: SmokeTerminalRun &
        Readonly<{ status: "failed"; errorCode: string }>;
    requestIds: Readonly<{
        successSubmit: string;
        successObserve: string;
        failureSubmit: string;
        failureObserve: string;
    }>;
}>;

export type AsyncInternalRollbackSmoke = Readonly<{
    schemaVersion: 1;
    event: "async_internal_rollback_smoke_completed";
    revision: string;
    startedAt: string;
    completedAt: string;
    intakeClosed: true;
    acceptedRunsQueryable: true;
    synchronousExecutionVerified: true;
    runIds: readonly [string, string];
}>;

type SmokeTerminalRun = Readonly<{
    runId: string;
    process: string;
    version: string;
    status: "succeeded" | "failed";
    createdAt: string;
    startedAt: string;
    finishedAt: string;
}>;

export type AsyncInternalSmokeOptions = Readonly<{
    baseUrl: string;
    revision: string;
    callerAAuthorization: string;
    callerBAuthorization: string;
    successRequest: unknown;
    failureRequest: unknown;
    expectedFailureCode: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
    clock?: () => string;
    createId?: () => string;
    wait?: (milliseconds: number) => Promise<void>;
    allowInsecureLoopback?: boolean;
}>;

export function createAsyncInternalSmoke(options: AsyncInternalSmokeOptions) {
    const baseUrl = trustedGatewayUrl(
        options.baseUrl,
        options.allowInsecureLoopback ?? false,
    );
    const revision = requiredRevision(options.revision);
    const callerAAuthorization = requiredSecret(
        options.callerAAuthorization,
        "caller A authorization",
    );
    const callerBAuthorization = requiredSecret(
        options.callerBAuthorization,
        "caller B authorization",
    );
    if (callerAAuthorization === callerBAuthorization) {
        throw new Error("The two smoke callers must use distinct credentials");
    }
    const expectedFailureCode = requiredSafeValue(
        options.expectedFailureCode,
        "expected failure code",
    );
    const timeoutMs = positiveInteger(options.timeoutMs ?? 300_000);
    const request = options.fetch ?? fetch;
    const clock = options.clock ?? (() => new Date().toISOString());
    const createId = options.createId ?? randomUUID;
    const wait =
        options.wait ??
        ((milliseconds) =>
            new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

    return Object.freeze({
        baseline: async (): Promise<AsyncInternalSmokeBaseline> => {
            const startedAt = clock();
            await expectReady(
                request,
                baseUrl,
                callerAAuthorization,
                timeoutMs,
            );
            const requestIds = Object.freeze({
                successSubmit: requestId("success-submit", createId()),
                successObserve: requestId("success-observe", createId()),
                failureSubmit: requestId("failure-submit", createId()),
                failureObserve: requestId("failure-observe", createId()),
            });
            const successAccepted = await submit(
                request,
                baseUrl,
                callerAAuthorization,
                options.successRequest,
                requestIds.successSubmit,
                createId(),
                timeoutMs,
            );
            const failureAccepted = await submit(
                request,
                baseUrl,
                callerAAuthorization,
                options.failureRequest,
                requestIds.failureSubmit,
                createId(),
                timeoutMs,
            );
            const [success, failure] = await Promise.all([
                waitForTerminal(
                    request,
                    baseUrl,
                    callerAAuthorization,
                    successAccepted.runId,
                    "succeeded",
                    requestIds.successObserve,
                    timeoutMs,
                    wait,
                ),
                waitForTerminal(
                    request,
                    baseUrl,
                    callerAAuthorization,
                    failureAccepted.runId,
                    "failed",
                    requestIds.failureObserve,
                    timeoutMs,
                    wait,
                ),
            ]);
            const failureCode = publicErrorCode(failure);
            if (failureCode !== expectedFailureCode) {
                throw new Error(
                    `Failure smoke returned unexpected public error ${failureCode}`,
                );
            }
            const successEvidence = publicTerminal(success, "succeeded");
            const failureEvidence = publicTerminal(failure, "failed");
            await verifyOwnerIsolation(
                request,
                baseUrl,
                callerBAuthorization,
                successEvidence.runId,
                timeoutMs,
            );
            await verifySynchronousExecution(
                request,
                baseUrl,
                callerAAuthorization,
                options.successRequest,
                timeoutMs,
            );
            return Object.freeze({
                schemaVersion: 1,
                event: "async_internal_gateway_smoke_completed",
                revision,
                startedAt,
                completedAt: clock(),
                healthReady: true,
                ownerIsolationVerified: true,
                synchronousExecutionVerified: true,
                success: successEvidence,
                failure: {
                    ...failureEvidence,
                    errorCode: failureCode,
                },
                requestIds,
            });
        },

        rollback: async (
            baseline: AsyncInternalSmokeBaseline,
        ): Promise<AsyncInternalRollbackSmoke> => {
            if (baseline.revision !== revision) {
                throw new Error(
                    "Rollback smoke revision differs from baseline",
                );
            }
            const startedAt = clock();
            const closed = await rawRequest(
                request,
                new URL("/process-runs", baseUrl),
                callerAAuthorization,
                timeoutMs,
                {
                    method: "POST",
                    requestId: requestId("closed-intake", createId()),
                    idempotencyKey: createId(),
                    body: options.successRequest,
                },
            );
            const closedBody = await jsonRecord(closed);
            if (
                closed.status !== 503 ||
                errorCode(closedBody) !== "ASYNC_INTAKE_CLOSED"
            ) {
                throw new Error(
                    `Rollback intake check failed with HTTP ${closed.status} (${errorCode(closedBody)})`,
                );
            }
            await Promise.all([
                expectExistingTerminal(
                    request,
                    baseUrl,
                    callerAAuthorization,
                    baseline.success.runId,
                    "succeeded",
                    timeoutMs,
                ),
                expectExistingTerminal(
                    request,
                    baseUrl,
                    callerAAuthorization,
                    baseline.failure.runId,
                    "failed",
                    timeoutMs,
                ),
                verifySynchronousExecution(
                    request,
                    baseUrl,
                    callerAAuthorization,
                    options.successRequest,
                    timeoutMs,
                ),
            ]);
            return Object.freeze({
                schemaVersion: 1,
                event: "async_internal_rollback_smoke_completed",
                revision,
                startedAt,
                completedAt: clock(),
                intakeClosed: true,
                acceptedRunsQueryable: true,
                synchronousExecutionVerified: true,
                runIds: [
                    baseline.success.runId,
                    baseline.failure.runId,
                ] as const,
            });
        },
    });
}

async function expectReady(
    request: typeof fetch,
    baseUrl: URL,
    authorization: string,
    timeoutMs: number,
): Promise<void> {
    for (const pathname of ["/healthz", "/readyz"]) {
        const response = await rawRequest(
            request,
            new URL(pathname, baseUrl),
            authorization,
            timeoutMs,
            { method: "GET", requestId: `async-smoke-${pathname.slice(1)}` },
        );
        if (!response.ok) {
            throw new Error(
                `Gateway ${pathname} failed with HTTP ${response.status}`,
            );
        }
    }
}

async function submit(
    request: typeof fetch,
    baseUrl: URL,
    authorization: string,
    body: unknown,
    requestIdValue: string,
    idempotencyKey: string,
    timeoutMs: number,
): Promise<{ runId: string }> {
    const response = await rawRequest(
        request,
        new URL("/process-runs", baseUrl),
        authorization,
        timeoutMs,
        {
            method: "POST",
            requestId: requestIdValue,
            idempotencyKey,
            body,
        },
    );
    const value = await jsonRecord(response);
    if (response.status !== 202 || typeof value.runId !== "string") {
        throw new Error(
            `Async smoke submission failed with HTTP ${response.status} (${errorCode(value)})`,
        );
    }
    return { runId: value.runId };
}

async function waitForTerminal(
    request: typeof fetch,
    baseUrl: URL,
    authorization: string,
    runId: string,
    expectedStatus: "succeeded" | "failed",
    requestIdValue: string,
    timeoutMs: number,
    wait: (milliseconds: number) => Promise<void>,
): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const response = await rawRequest(
            request,
            new URL(`/process-runs/${encodeURIComponent(runId)}`, baseUrl),
            authorization,
            timeoutMs,
            { method: "GET", requestId: requestIdValue },
        );
        const value = await jsonRecord(response);
        if (!response.ok) {
            throw new Error(
                `Async smoke query failed with HTTP ${response.status} (${errorCode(value)})`,
            );
        }
        if (value.status === expectedStatus) return value;
        if (value.status === "succeeded" || value.status === "failed") {
            throw new Error(
                `Async smoke expected ${expectedStatus} but observed ${String(value.status)}`,
            );
        }
        const retryAfter = Number(response.headers.get("retry-after"));
        await wait(
            Number.isInteger(retryAfter) && retryAfter >= 1
                ? Math.min(retryAfter, 30) * 1_000
                : 1_000,
        );
    }
    throw new Error(`Async smoke Run ${runId} did not reach a terminal state`);
}

async function expectExistingTerminal(
    request: typeof fetch,
    baseUrl: URL,
    authorization: string,
    runId: string,
    status: "succeeded" | "failed",
    timeoutMs: number,
): Promise<void> {
    const response = await rawRequest(
        request,
        new URL(`/process-runs/${encodeURIComponent(runId)}`, baseUrl),
        authorization,
        timeoutMs,
        { method: "GET", requestId: `async-smoke-rollback-${status}` },
    );
    const value = await jsonRecord(response);
    if (!response.ok || value.status !== status) {
        throw new Error(
            `Accepted ${status} Run is unavailable during rollback`,
        );
    }
}

async function verifyOwnerIsolation(
    request: typeof fetch,
    baseUrl: URL,
    authorization: string,
    runId: string,
    timeoutMs: number,
): Promise<void> {
    const [unauthorized, unknown] = await Promise.all([
        rawRequest(
            request,
            new URL(`/process-runs/${encodeURIComponent(runId)}`, baseUrl),
            authorization,
            timeoutMs,
            { method: "GET", requestId: "async-smoke-owner-isolation" },
        ),
        rawRequest(
            request,
            new URL(
                "/process-runs/00000000-0000-4000-8000-000000000000",
                baseUrl,
            ),
            authorization,
            timeoutMs,
            { method: "GET", requestId: "async-smoke-unknown-run" },
        ),
    ]);
    const [unauthorizedBody, unknownBody] = await Promise.all([
        unauthorized.text(),
        unknown.text(),
    ]);
    if (
        unauthorized.status !== 404 ||
        unknown.status !== 404 ||
        unauthorized.headers.get("content-type") !==
            unknown.headers.get("content-type") ||
        unauthorizedBody !== unknownBody
    ) {
        throw new Error("Owner isolation or non-enumerability check failed");
    }
}

async function verifySynchronousExecution(
    request: typeof fetch,
    baseUrl: URL,
    authorization: string,
    body: unknown,
    timeoutMs: number,
): Promise<void> {
    const response = await rawRequest(
        request,
        new URL("/execute", baseUrl),
        authorization,
        timeoutMs,
        {
            method: "POST",
            requestId: "async-smoke-synchronous-execute",
            body,
        },
    );
    const value = await jsonRecord(response);
    if (!response.ok || value.status !== "succeeded") {
        throw new Error(
            `Synchronous execution check failed with HTTP ${response.status} (${errorCode(value)})`,
        );
    }
}

function rawRequest(
    request: typeof fetch,
    url: URL,
    authorization: string,
    timeoutMs: number,
    options: Readonly<{
        method: "GET" | "POST";
        requestId: string;
        idempotencyKey?: string;
        body?: unknown;
    }>,
): Promise<Response> {
    return request(url, {
        method: options.method,
        headers: {
            authorization,
            "x-request-id": options.requestId,
            "x-pipipi-caller-id": "forged-by-smoke-must-be-removed",
            "x-pipipi-gateway-token": "forged-by-smoke-must-be-removed",
            ...(options.idempotencyKey
                ? { "idempotency-key": options.idempotencyKey }
                : {}),
            ...(options.body === undefined
                ? {}
                : { "content-type": "application/json" }),
        },
        ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(timeoutMs),
    });
}

async function jsonRecord(
    response: Response,
): Promise<Record<string, unknown>> {
    try {
        const value: unknown = await response.json();
        if (
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value)
        ) {
            return value as Record<string, unknown>;
        }
    } catch {
        // The error below is deliberately content-free.
    }
    throw new Error(
        `Gateway returned non-object JSON with HTTP ${response.status}`,
    );
}

function publicTerminal<Status extends "succeeded" | "failed">(
    value: Record<string, unknown>,
    status: Status,
): SmokeTerminalRun & Readonly<{ status: Status }> {
    for (const key of [
        "runId",
        "process",
        "version",
        "createdAt",
        "startedAt",
        "finishedAt",
    ]) {
        if (typeof value[key] !== "string") {
            throw new Error(`Terminal Run is missing ${key}`);
        }
    }
    return Object.freeze({
        runId: value.runId as string,
        process: value.process as string,
        version: value.version as string,
        status,
        createdAt: value.createdAt as string,
        startedAt: value.startedAt as string,
        finishedAt: value.finishedAt as string,
    });
}

function publicErrorCode(value: Record<string, unknown>): string {
    if (
        typeof value.error === "object" &&
        value.error !== null &&
        "code" in value.error &&
        typeof value.error.code === "string"
    ) {
        return value.error.code;
    }
    return "UNKNOWN";
}

function errorCode(value: Record<string, unknown>): string {
    return publicErrorCode(value);
}

function trustedGatewayUrl(value: string, allowLoopback: boolean): URL {
    const url = new URL(value);
    const loopback =
        url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (
        (url.protocol !== "https:" && !(allowLoopback && loopback)) ||
        url.username ||
        url.password
    ) {
        throw new Error("Async internal smoke requires an HTTPS gateway URL");
    }
    return url;
}

function requiredRevision(value: string): string {
    if (!/^[0-9a-f]{40}$/.test(value)) {
        throw new Error(
            "Async internal smoke revision must be a full commit SHA",
        );
    }
    return value;
}

function requiredSecret(value: string, label: string): string {
    if (!value.trim()) throw new Error(`${label} is required`);
    return value;
}

function requiredSafeValue(value: string, label: string): string {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(value)) {
        throw new Error(`${label} is invalid`);
    }
    return value;
}

function positiveInteger(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("Async internal smoke timeout must be positive");
    }
    return value;
}

function requestId(label: string, id: string): string {
    return `async-smoke-${label}-${id}`.slice(0, 200);
}
