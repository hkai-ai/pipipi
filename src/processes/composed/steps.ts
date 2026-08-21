/** composed-task/v1 的 Step Run：把一次 Member 调用交给 Process Attempt Runner，并收敛为可公开的步骤记录 */
import type {
    JsonValue,
    ProcessAttemptRunner,
    ProcessErrorCode,
    ProcessRegistration,
} from "../../process-runtime/index.js";
import type { MemberSpec } from "./members.js";

export type StepRecord = Readonly<{
    step: number;
    process: string;
    version: string;
    status: "succeeded" | "failed";
    /** The Member's validated public output; present only on success. */
    output?: JsonValue;
    error?: Readonly<{ code: ProcessErrorCode; message: string }>;
    /** Whether a success here spent money or persisted an artefact. */
    priced: boolean;
}>;

export type StepRunRequest = Readonly<{
    stepNumber: number;
    member: MemberSpec;
    registration: ProcessRegistration;
    input: unknown;
    attemptRunner: ProcessAttemptRunner;
    parent: Readonly<{ runId: string; signal: AbortSignal }>;
}>;

/**
 * A Step's `runId` derives from its parent so the Member's idempotency key is
 * stable across parent Attempts, and so the Step's activity timeline sits next
 * to the parent's in the same log stream.
 */
export function stepRunId(parentRunId: string, stepNumber: number): string {
    return `${parentRunId}.${stepNumber}`;
}

/**
 * Runs one Member through the same Attempt governance as a top-level Run:
 * the Member's own `accept`, time limit, cancellation, error sanitising and
 * activity log all apply unchanged. Nothing here throws; every outcome is a
 * record the Planner can read.
 */
export async function runStep(request: StepRunRequest): Promise<StepRecord> {
    const base = {
        step: request.stepNumber,
        process: request.member.process,
        version: request.member.version,
        priced: request.member.sideEffect === "priced",
    };

    let acceptance: ReturnType<ProcessRegistration["accept"]>;
    try {
        acceptance = request.registration.accept(request.input);
    } catch {
        return Object.freeze({
            ...base,
            status: "failed",
            error: Object.freeze({
                code: "INTERNAL_ERROR",
                message: "The step could not be completed",
            }),
        });
    }
    if (!acceptance.accepted) {
        return Object.freeze({
            ...base,
            status: "failed",
            error: Object.freeze({
                code: "INVALID_INPUT",
                message: "The step input is invalid",
            }),
        });
    }

    const result = await request.attemptRunner.run({
        runId: stepRunId(request.parent.runId, request.stepNumber),
        registration: request.registration,
        acceptedInput: acceptance.acceptedInput,
        signal: request.parent.signal,
    });
    if (result.status === "succeeded") {
        return Object.freeze({
            ...base,
            status: "succeeded",
            // The Registration already reduced this to a JSON-safe snapshot.
            output: result.output as JsonValue,
        });
    }
    return Object.freeze({
        ...base,
        status: "failed",
        error: Object.freeze({
            code: result.error.code,
            message: result.error.message,
        }),
    });
}
