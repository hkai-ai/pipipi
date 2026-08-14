import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
    createPaidAsyncImageSmoke,
    type PaidAsyncImageSmokeEvidence,
} from "../src/app/paid-async-image-smoke.js";

const evidenceFile = resolve(
    process.env.PAID_ASYNC_EVIDENCE_FILE ??
        "artifacts/paid-async-image-smoke/evidence.json",
);
const rawRevision = process.env.PAID_ASYNC_REVISION?.trim() ?? "";
const rawCostLimit = process.env.PAID_ASYNC_COST_LIMIT_USD?.trim() ?? "";
const rawCostReference =
    process.env.PAID_ASYNC_COST_APPROVAL_REFERENCE?.trim() ?? "";
const revision = /^[0-9a-f]{40}$/.test(rawRevision) ? rawRevision : "unknown";
const costLimit = /^(?:0|[1-9][0-9]{0,3})(?:\.[0-9]{1,2})?$/.test(rawCostLimit)
    ? rawCostLimit
    : "unknown";
const costReference = /^[A-Za-z0-9._:/-]{1,128}$/.test(rawCostReference)
    ? rawCostReference
    : "unknown";
const startedAt = new Date().toISOString();

let evidence: PaidAsyncImageSmokeEvidence | PreflightFailure;
try {
    evidence = await createPaidAsyncImageSmoke({
        baseUrl: required("PAID_ASYNC_GATEWAY_URL"),
        revision: required("PAID_ASYNC_REVISION"),
        authorization: required("PAID_ASYNC_CALLER_AUTHORIZATION"),
        sourceImageUrl: required("PAID_ASYNC_SOURCE_IMAGE_URL"),
        expectedOssHost: required("PAID_ASYNC_EXPECTED_OSS_HOST"),
        expectedOssPathPrefix: required("PAID_ASYNC_EXPECTED_OSS_PATH_PREFIX"),
        costApproval: {
            currency: "USD",
            limit: required("PAID_ASYNC_COST_LIMIT_USD"),
            reference: required("PAID_ASYNC_COST_APPROVAL_REFERENCE"),
        },
        timeoutMs:
            positiveInteger(
                process.env.PAID_ASYNC_TIMEOUT_SECONDS ?? "300",
                "PAID_ASYNC_TIMEOUT_SECONDS",
            ) * 1_000,
    }).run();
} catch {
    evidence = Object.freeze({
        schemaVersion: 1,
        event: "paid_async_image_smoke_completed",
        revision,
        status: "failed",
        failedGate: "preflight_or_transport",
        startedAt,
        completedAt: new Date().toISOString(),
        process: Object.freeze({ id: "crt-interface-image", version: "v1" }),
        runId: null,
        processRunStatus: "unknown",
        publicErrorCode: "PAID_SMOKE_PREFLIGHT_OR_TRANSPORT_FAILURE",
        costApproval: Object.freeze({
            currency: "USD",
            limit: costLimit,
            reference: costReference,
        }),
    });
}

await writeEvidence(evidenceFile, evidence);
console.log(
    JSON.stringify({
        event: evidence.event,
        revision: evidence.revision,
        status: evidence.status,
        process: evidence.process,
        runId: evidence.runId,
        processRunStatus: evidence.processRunStatus,
        ...(evidence.status === "failed"
            ? {
                  failedGate: evidence.failedGate,
                  publicErrorCode: evidence.publicErrorCode,
              }
            : {
                  object: evidence.object,
                  recovery: evidence.recovery,
              }),
    }),
);
if (evidence.status !== "succeeded") process.exitCode = 1;

async function writeEvidence(file: string, value: unknown): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
    });
    await rename(temporary, file);
}

function required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function positiveInteger(value: string, name: string): number {
    if (!/^[1-9][0-9]*$/.test(value)) {
        throw new Error(`${name} must be a positive integer`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`${name} must be a safe integer`);
    }
    return parsed;
}

type PreflightFailure = Readonly<{
    schemaVersion: 1;
    event: "paid_async_image_smoke_completed";
    revision: string;
    status: "failed";
    failedGate: "preflight_or_transport";
    startedAt: string;
    completedAt: string;
    process: Readonly<{ id: "crt-interface-image"; version: "v1" }>;
    runId: null;
    processRunStatus: "unknown";
    publicErrorCode: "PAID_SMOKE_PREFLIGHT_OR_TRANSPORT_FAILURE";
    costApproval: Readonly<{
        currency: "USD";
        limit: string;
        reference: string;
    }>;
}>;
