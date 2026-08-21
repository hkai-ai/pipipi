import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    type AsyncInternalSmokeBaseline,
    createAsyncInternalSmoke,
} from "../src/release/async-internal-smoke.js";

const phase = required("ASYNC_INTERNAL_SMOKE_PHASE");
if (phase !== "baseline" && phase !== "rollback") {
    throw new Error("ASYNC_INTERNAL_SMOKE_PHASE must be baseline or rollback");
}
const evidenceDirectory = path.resolve(
    required("ASYNC_INTERNAL_SMOKE_EVIDENCE_DIRECTORY"),
);
const smoke = createAsyncInternalSmoke({
    baseUrl: required("ASYNC_INTERNAL_GATEWAY_BASE_URL"),
    revision: required("ASYNC_INTERNAL_CANDIDATE_REVISION"),
    callerAAuthorization: required("ASYNC_INTERNAL_CALLER_A_AUTHORIZATION"),
    callerBAuthorization: required("ASYNC_INTERNAL_CALLER_B_AUTHORIZATION"),
    successRequest: jsonEnvironment("ASYNC_INTERNAL_SUCCESS_REQUEST"),
    failureRequest: jsonEnvironment("ASYNC_INTERNAL_FAILURE_REQUEST"),
    expectedFailureCode:
        process.env.ASYNC_INTERNAL_FAILURE_CODE ?? "DEPENDENCY_FAILURE",
    timeoutMs: positiveInteger(
        process.env.ASYNC_INTERNAL_SMOKE_TIMEOUT_MS,
        300_000,
    ),
});

await mkdir(evidenceDirectory, { recursive: true });
if (phase === "baseline") {
    const evidence = await smoke.baseline();
    await persist("baseline.json", evidence);
    report(evidence);
} else {
    const baseline = JSON.parse(
        await readFile(path.join(evidenceDirectory, "baseline.json"), "utf8"),
    ) as AsyncInternalSmokeBaseline;
    const evidence = await smoke.rollback(baseline);
    await persist("rollback.json", evidence);
    report(evidence);
}

async function persist(name: string, value: unknown): Promise<void> {
    await writeFile(
        path.join(evidenceDirectory, name),
        `${JSON.stringify(value, null, 2)}\n`,
        { mode: 0o600 },
    );
}

function report(value: { event: string; revision: string }): void {
    console.log(
        JSON.stringify({ event: value.event, revision: value.revision }),
    );
}

function required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function jsonEnvironment(name: string): unknown {
    try {
        return JSON.parse(required(name));
    } catch {
        throw new Error(`${name} must contain valid JSON`);
    }
}

function positiveInteger(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error("ASYNC_INTERNAL_SMOKE_TIMEOUT_MS must be positive");
    }
    return parsed;
}
