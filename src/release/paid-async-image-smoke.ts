import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { isPublicSourceImageUrl } from "../processes/crt/capability.js";
import { paletteColors } from "../processes/crt/style.js";

const process = Object.freeze({ id: "crt-interface-image", version: "v1" });
const palette = "经典";
const aspectRatio = "4:3";
const grain = "normal";
const maxImageBytes = 50 * 1024 * 1024;

type PaidSmokeRecovery = Readonly<{
    submissionAttempts: number;
    uniqueRuns: number;
    initialAcceptanceInterrupted: boolean;
    acceptanceResponseRecoveryVerified: boolean;
    querySessions: number;
    queryRecoveryVerified: boolean;
    initialQueryInterrupted: boolean;
}>;

type PaidSmokeCostApproval = Readonly<{
    currency: "USD";
    limit: string;
    reference: string;
}>;

type PaidSmokeObject = Readonly<{
    identitySha256: string;
    contentSha256: string;
    contentType: "image/png";
    bytes: number;
    width: number;
    height: number;
    expectedOssLocationVerified: true;
    accessible: true;
    opaque: true;
    paletteVerified: true;
}>;

type PaidSmokeCommon = Readonly<{
    schemaVersion: 1;
    event: "paid_async_image_smoke_completed";
    revision: string;
    startedAt: string;
    completedAt: string;
    process: typeof process;
    runId: string;
    processRunStatus: "unknown" | "succeeded" | "failed";
    recovery: PaidSmokeRecovery;
    costApproval: PaidSmokeCostApproval;
}>;

type PaidSmokeFailure = PaidSmokeCommon &
    Readonly<{
        status: "failed";
        failedGate:
            | "acceptance_recovery"
            | "terminal"
            | "query_recovery"
            | "object_verification";
        publicErrorCode: string;
    }>;

export type PaidAsyncImageSmokeEvidence =
    | (PaidSmokeCommon &
          Readonly<{
              status: "succeeded";
              object: PaidSmokeObject;
          }>)
    | PaidSmokeFailure;

export type PaidAsyncImageSmokeOptions = Readonly<{
    baseUrl: string;
    revision: string;
    authorization: string;
    sourceImageUrl: string;
    expectedOssHost: string;
    expectedOssPathPrefix: string;
    costApproval: Readonly<{
        currency: "USD";
        limit: string;
        reference: string;
    }>;
    timeoutMs?: number;
    fetch?: typeof fetch;
    createId?: () => string;
    wait?: (milliseconds: number) => Promise<void>;
    clock?: () => string;
    now?: () => number;
}>;

export function createPaidAsyncImageSmoke(options: PaidAsyncImageSmokeOptions) {
    const baseUrl = gatewayUrl(options.baseUrl);
    const revision = requiredRevision(options.revision);
    const authorization = requiredSecret(options.authorization);
    const sourceImageUrl = publicSourceUrl(options.sourceImageUrl);
    const expectedOssHost = requiredHost(options.expectedOssHost);
    const expectedOssPathPrefix = requiredPathPrefix(
        options.expectedOssPathPrefix,
    );
    const costApproval = approvedCost(options.costApproval);
    const timeoutMs = positiveInteger(options.timeoutMs ?? 300_000);
    const request = options.fetch ?? fetch;
    const createId = options.createId ?? randomUUID;
    const wait =
        options.wait ??
        ((milliseconds) =>
            new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const clock = options.clock ?? (() => new Date().toISOString());
    const now = options.now ?? Date.now;

    return Object.freeze({
        run: async (): Promise<PaidAsyncImageSmokeEvidence> => {
            const startedAt = clock();
            const failure = (
                value: Readonly<{
                    failedGate: PaidSmokeFailure["failedGate"];
                    publicErrorCode: string;
                    runId: string;
                    processRunStatus: PaidSmokeCommon["processRunStatus"];
                    recovery: PaidSmokeRecovery;
                }>,
            ): PaidSmokeFailure =>
                Object.freeze({
                    schemaVersion: 1,
                    event: "paid_async_image_smoke_completed",
                    revision,
                    status: "failed",
                    startedAt,
                    completedAt: clock(),
                    process,
                    costApproval,
                    ...value,
                });
            const idempotencyKey = requiredIdempotencyKey(createId());
            const body = Object.freeze({
                process: process.id,
                version: process.version,
                input: Object.freeze({
                    sourceImageUrl,
                    palette,
                    aspectRatio,
                    grain,
                }),
            });
            let interruptedRunId: string | null = null;
            try {
                interruptedRunId = await interruptAcceptedResponse({
                    request,
                    baseUrl,
                    authorization,
                    idempotencyKey,
                    body,
                    deadline: submissionDeadline(now),
                    now,
                });
            } catch {
                // The replay below is the only safe recovery when the caller
                // cannot tell whether the first acceptance reached the server.
            }
            let replay: { runId: string };
            try {
                replay = await submit({
                    request,
                    baseUrl,
                    authorization,
                    idempotencyKey,
                    body,
                    deadline: submissionDeadline(now),
                    now,
                });
            } catch {
                if (interruptedRunId === null) throw new Error("unrecoverable");
                return failure({
                    failedGate: "acceptance_recovery",
                    runId: interruptedRunId,
                    processRunStatus: "unknown",
                    publicErrorCode: "PAID_SMOKE_ACCEPTANCE_RECOVERY_FAILED",
                    recovery: Object.freeze({
                        submissionAttempts: 2,
                        uniqueRuns: 1,
                        initialAcceptanceInterrupted: true,
                        acceptanceResponseRecoveryVerified: false,
                        querySessions: 0,
                        queryRecoveryVerified: false,
                        initialQueryInterrupted: false,
                    }),
                });
            }
            if (
                interruptedRunId !== null &&
                interruptedRunId !== replay.runId
            ) {
                return failure({
                    failedGate: "acceptance_recovery",
                    runId: interruptedRunId,
                    processRunStatus: "unknown",
                    publicErrorCode: "PAID_SMOKE_IDEMPOTENCY_FAILURE",
                    recovery: Object.freeze({
                        submissionAttempts: 2,
                        uniqueRuns: 2,
                        initialAcceptanceInterrupted: true,
                        acceptanceResponseRecoveryVerified: false,
                        querySessions: 0,
                        queryRecoveryVerified: false,
                        initialQueryInterrupted: false,
                    }),
                });
            }

            const deadline = now() + timeoutMs;

            let initialQueryInterrupted = false;
            try {
                await query({
                    request,
                    baseUrl,
                    authorization,
                    runId: replay.runId,
                    deadline,
                    now,
                });
            } catch {
                initialQueryInterrupted = true;
            }
            let terminal: Record<string, unknown>;
            try {
                terminal = await waitForTerminal({
                    request,
                    baseUrl,
                    authorization,
                    runId: replay.runId,
                    deadline,
                    now,
                    wait,
                });
            } catch {
                return failure({
                    failedGate: "query_recovery",
                    runId: replay.runId,
                    processRunStatus: "unknown",
                    publicErrorCode: "PAID_SMOKE_QUERY_RECOVERY_FAILED",
                    recovery: Object.freeze({
                        ...recoveryEvidence(initialQueryInterrupted),
                        queryRecoveryVerified: false,
                    }),
                });
            }
            if (terminal.status !== "succeeded") {
                return failure({
                    failedGate: "terminal",
                    runId: replay.runId,
                    processRunStatus: "failed",
                    publicErrorCode: terminalErrorCode(terminal),
                    recovery: recoveryEvidence(initialQueryInterrupted),
                });
            }
            let object: PaidSmokeObject;
            try {
                const image = successfulImage(terminal);
                object = await verifyObject({
                    request,
                    image,
                    expectedOssHost,
                    expectedOssPathPrefix,
                    deadline,
                    now,
                });
            } catch {
                return failure({
                    failedGate: "object_verification",
                    runId: replay.runId,
                    processRunStatus: "succeeded",
                    publicErrorCode: "PAID_SMOKE_OBJECT_VERIFICATION_FAILED",
                    recovery: recoveryEvidence(initialQueryInterrupted),
                });
            }
            return Object.freeze({
                schemaVersion: 1,
                event: "paid_async_image_smoke_completed",
                revision,
                status: "succeeded",
                startedAt,
                completedAt: clock(),
                process,
                runId: replay.runId,
                processRunStatus: "succeeded",
                recovery: recoveryEvidence(initialQueryInterrupted),
                object,
                costApproval,
            });
        },
    });
}

function recoveryEvidence(initialQueryInterrupted: boolean): PaidSmokeRecovery {
    return Object.freeze({
        submissionAttempts: 2,
        uniqueRuns: 1,
        initialAcceptanceInterrupted: true,
        acceptanceResponseRecoveryVerified: true,
        querySessions: 2,
        queryRecoveryVerified: true,
        initialQueryInterrupted,
    });
}

function terminalErrorCode(value: Record<string, unknown>): string {
    if (
        !isRecord(value.error) ||
        typeof value.error.code !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.error.code)
    ) {
        throw new Error("Paid smoke Process returned an invalid public error");
    }
    return value.error.code;
}

type RequestContext = Readonly<{
    request: typeof fetch;
    baseUrl: URL;
    authorization: string;
    deadline: number;
    now: () => number;
}>;

async function submit(
    options: RequestContext &
        Readonly<{
            idempotencyKey: string;
            body: unknown;
        }>,
): Promise<{ runId: string }> {
    const response = await postAcceptance(options);
    const value = await jsonRecord(response);
    if (
        response.status !== 202 ||
        !exactProcessRun(value) ||
        !["queued", "running", "succeeded", "failed"].includes(
            String(value.status),
        )
    ) {
        throw new Error("Paid smoke submission was not durably accepted");
    }
    return { runId: value.runId };
}

async function interruptAcceptedResponse(
    options: RequestContext &
        Readonly<{
            idempotencyKey: string;
            body: unknown;
        }>,
): Promise<string> {
    const response = await postAcceptance(options);
    const location = response.headers.get("location");
    if (response.status !== 202 || location === null) {
        throw new Error("Paid smoke acceptance could not be interrupted");
    }
    const accepted = new URL(location, options.baseUrl);
    const match = /^\/process-runs\/([^/?#]+)$/.exec(accepted.pathname);
    if (
        accepted.origin !== options.baseUrl.origin ||
        accepted.search !== "" ||
        accepted.hash !== "" ||
        match?.[1] === undefined
    ) {
        throw new Error("Paid smoke acceptance location is invalid");
    }
    const runId = decodeURIComponent(match[1]);
    if (runId.length < 1 || runId.length > 128) {
        throw new Error("Paid smoke acceptance Run ID is invalid");
    }
    await response.body?.cancel();
    return runId;
}

async function postAcceptance(
    options: RequestContext &
        Readonly<{
            idempotencyKey: string;
            body: unknown;
        }>,
): Promise<Response> {
    return options.request(new URL("/process-runs", options.baseUrl), {
        method: "POST",
        headers: {
            authorization: options.authorization,
            "content-type": "application/json",
            "idempotency-key": options.idempotencyKey,
            "x-pipipi-caller-id": "forged-paid-smoke-must-be-removed",
            "x-pipipi-gateway-token": "forged-paid-smoke-must-be-removed",
        },
        body: JSON.stringify(options.body),
        signal: requestSignal(options.deadline, options.now),
    });
}

async function query(
    options: RequestContext & Readonly<{ runId: string }>,
): Promise<Record<string, unknown>> {
    const response = await options.request(
        new URL(
            `/process-runs/${encodeURIComponent(options.runId)}`,
            options.baseUrl,
        ),
        {
            method: "GET",
            headers: { authorization: options.authorization },
            signal: requestSignal(options.deadline, options.now),
        },
    );
    const value = await jsonRecord(response);
    if (
        response.status !== 200 ||
        !exactProcessRun(value) ||
        value.runId !== options.runId
    ) {
        throw new Error("Paid smoke owner query failed");
    }
    return value;
}

async function waitForTerminal(
    options: RequestContext &
        Readonly<{
            runId: string;
            wait: (milliseconds: number) => Promise<void>;
        }>,
): Promise<Record<string, unknown>> {
    while (options.now() < options.deadline) {
        const value = await query(options);
        if (value.status === "succeeded" || value.status === "failed") {
            return value;
        }
        await options.wait(1_000);
    }
    throw new Error("Paid smoke owner query timed out");
}

function successfulImage(value: Record<string, unknown>): {
    url: string;
    contentType: "image/png";
    width: number;
    height: number;
} {
    if (!isRecord(value.output) || !isRecord(value.output.image)) {
        throw new Error("Paid smoke Process returned no final image");
    }
    const image = value.output.image;
    if (
        typeof image.url !== "string" ||
        image.contentType !== "image/png" ||
        !positiveNumber(image.width) ||
        !positiveNumber(image.height)
    ) {
        throw new Error("Paid smoke Process returned an invalid final image");
    }
    return {
        url: image.url,
        contentType: "image/png",
        width: image.width,
        height: image.height,
    };
}

async function verifyObject(options: {
    request: typeof fetch;
    image: ReturnType<typeof successfulImage>;
    expectedOssHost: string;
    expectedOssPathPrefix: string;
    deadline: number;
    now: () => number;
}): Promise<PaidSmokeObject> {
    const url = new URL(options.image.url);
    if (
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        url.hash !== "" ||
        url.hostname.toLowerCase() !== options.expectedOssHost ||
        !url.pathname.startsWith(options.expectedOssPathPrefix)
    ) {
        throw new Error("Paid smoke result is outside approved OSS storage");
    }
    const response = await options.request(url, {
        method: "GET",
        redirect: "manual",
        signal: requestSignal(options.deadline, options.now),
    });
    const contentType = response.headers.get("content-type")?.split(";", 1)[0];
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (
        !response.ok ||
        contentType !== "image/png" ||
        (declaredLength > 0 && declaredLength > maxImageBytes)
    ) {
        throw new Error("Paid smoke OSS object was not an accessible PNG");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > maxImageBytes) {
        throw new Error("Paid smoke OSS object size is invalid");
    }
    const metadata = await sharp(bytes).metadata();
    if (
        metadata.format !== "png" ||
        metadata.width !== options.image.width ||
        metadata.height !== options.image.height ||
        metadata.hasAlpha
    ) {
        throw new Error("Paid smoke OSS PNG does not match Process metadata");
    }
    const { data, info } = await sharp(bytes)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const allowed = new Set(paletteColors(palette)?.map(hexToRgbKey));
    for (let offset = 0; offset < data.length; offset += info.channels) {
        const key = `${data[offset]},${data[offset + 1]},${data[offset + 2]}`;
        if (!allowed.has(key)) {
            throw new Error("Paid smoke OSS PNG is outside the fixed palette");
        }
    }
    return Object.freeze({
        identitySha256: sha256(`${url.origin}${url.pathname}`),
        contentSha256: sha256(bytes),
        contentType: "image/png",
        bytes: bytes.length,
        width: metadata.width,
        height: metadata.height,
        expectedOssLocationVerified: true,
        accessible: true,
        opaque: true,
        paletteVerified: true,
    });
}

function hexToRgbKey(value: string): string {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
    if (!match) throw new Error("Paid smoke palette configuration is invalid");
    return `${Number.parseInt(match[1] ?? "", 16)},${Number.parseInt(match[2] ?? "", 16)},${Number.parseInt(match[3] ?? "", 16)}`;
}

async function jsonRecord(
    response: Response,
): Promise<Record<string, unknown>> {
    const text = await response.text();
    if (!text) throw new Error("Paid smoke endpoint returned no JSON");
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error("Paid smoke endpoint returned invalid JSON");
    }
    if (!isRecord(value))
        throw new Error("Paid smoke endpoint returned invalid JSON");
    return value;
}

function exactProcessRun(
    value: Record<string, unknown>,
): value is Record<string, unknown> & { runId: string } {
    return (
        typeof value.runId === "string" &&
        value.runId.length >= 1 &&
        value.runId.length <= 128 &&
        value.process === process.id &&
        value.version === process.version
    );
}

function requestSignal(deadline: number, now: () => number): AbortSignal {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("Paid smoke deadline elapsed");
    return AbortSignal.timeout(Math.min(remaining, 30_000));
}

function submissionDeadline(now: () => number): number {
    return now() + 30_000;
}

function gatewayUrl(value: string): URL {
    const url = new URL(value);
    if (
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== ""
    ) {
        throw new Error("Paid smoke gateway must be an HTTPS URL");
    }
    return url;
}

function requiredRevision(value: string): string {
    if (!/^[0-9a-f]{40}$/.test(value)) {
        throw new Error("Paid smoke revision must be a full commit SHA");
    }
    return value;
}

function requiredSecret(value: string): string {
    if (value.trim().length === 0 || /[\r\n]/.test(value)) {
        throw new Error("Paid smoke caller authorization is required");
    }
    return value;
}

function publicSourceUrl(value: string): string {
    if (!isPublicSourceImageUrl(value)) {
        throw new Error("Paid smoke source must be a public HTTPS image URL");
    }
    return value;
}

function requiredHost(value: string): string {
    const candidate = value.trim().toLowerCase();
    if (!/^(?=.{1,253}$)[a-z0-9.-]+$/.test(candidate)) {
        throw new Error("Paid smoke expected OSS host is invalid");
    }
    return candidate;
}

function requiredPathPrefix(value: string): string {
    const candidate = value.trim();
    if (
        !candidate.startsWith("/") ||
        !candidate.endsWith("/") ||
        candidate.includes("..") ||
        /[?#\r\n]/.test(candidate)
    ) {
        throw new Error("Paid smoke expected OSS path prefix is invalid");
    }
    return candidate;
}

function approvedCost(
    value: PaidAsyncImageSmokeOptions["costApproval"],
): PaidSmokeCostApproval {
    if (value.currency !== "USD") {
        throw new Error("Paid smoke cost approval currency must be USD");
    }
    if (!/^(?:0|[1-9][0-9]{0,3})(?:\.[0-9]{1,2})?$/.test(value.limit)) {
        throw new Error("Paid smoke cost limit is invalid");
    }
    const cents = Math.round(Number(value.limit) * 100);
    if (cents < 1) throw new Error("Paid smoke cost limit must be positive");
    if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(value.reference)) {
        throw new Error("Paid smoke cost approval reference is invalid");
    }
    return Object.freeze({
        currency: "USD",
        limit: (cents / 100).toFixed(2),
        reference: value.reference,
    });
}

function requiredIdempotencyKey(value: string): string {
    if (value.length < 1 || Buffer.byteLength(value, "utf8") > 512) {
        throw new Error("Paid smoke operation key is invalid");
    }
    return value;
}

function positiveInteger(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("Paid smoke timeout must be a positive integer");
    }
    return value;
}

function positiveNumber(value: unknown): value is number {
    return (
        typeof value === "number" && Number.isSafeInteger(value) && value > 0
    );
}

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
