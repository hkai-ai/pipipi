import type { z } from "zod";
import type { ProcessRunActivity } from "./logging.js";

const inputMaxBytes = 262_144;
const outputMaxBytes = 262_144;
const identityMaxBytes = 4_096;
const snapshotOverheadBytes = 27;
const acceptedMaxBytes =
    inputMaxBytes + identityMaxBytes + snapshotOverheadBytes;

export type ProcessIdentity = Readonly<{
    id: string;
    version: string;
}>;

export type ProcessExecutionContext = Readonly<{
    runId: string;
    signal: AbortSignal;
    runActivity: ProcessRunActivity;
}>;

type ProcessRegistrationRunContext = Readonly<{
    runId: string;
    signal: AbortSignal;
    runActivity?: ProcessRunActivity;
}>;

export type ExpectedProcessErrorCode = "AGENT_FAILURE" | "DEPENDENCY_FAILURE";

const expectedProcessFailureBrand: unique symbol = Symbol(
    "ExpectedProcessFailure",
);

export type ExpectedProcessFailure = Readonly<{
    code: ExpectedProcessErrorCode;
    publicMessage: string;
    [expectedProcessFailureBrand]: true;
}>;

export function failProcess(
    code: ExpectedProcessErrorCode,
    publicMessage: string,
): ExpectedProcessFailure {
    return Object.freeze({
        code,
        publicMessage,
        [expectedProcessFailureBrand]: true as const,
    });
}

export type ProcessRegistrationCompletion =
    | Readonly<{ status: "succeeded"; output: unknown }>
    | Readonly<{
          status: "failed";
          error:
              | ExpectedProcessFailure
              | Readonly<{
                    code: "INVALID_OUTPUT";
                    publicMessage: string;
                }>;
      }>;

export type JsonValue =
    | null
    | boolean
    | number
    | string
    | readonly JsonValue[]
    | Readonly<{ [key: string]: JsonValue }>;

export type AcceptedProcessInput = Readonly<{
    schemaVersion: 1;
    process: string;
    version: string;
    input: JsonValue;
}>;

export type ProcessRegistrationAcceptance =
    | Readonly<{ accepted: false }>
    | Readonly<{
          accepted: true;
          acceptedInput: AcceptedProcessInput;
      }>;

export type ProcessRetryPolicy = Readonly<{
    maximumAttempts: number;
    retryableErrorCodes: readonly ExpectedProcessErrorCode[];
    backoff: Readonly<{
        initialDelayMs: number;
        maximumDelayMs: number;
    }>;
}>;

const noRetryPolicy: ProcessRetryPolicy = Object.freeze({
    maximumAttempts: 1,
    retryableErrorCodes: Object.freeze([]),
    backoff: Object.freeze({ initialDelayMs: 1_000, maximumDelayMs: 1_000 }),
});

export const processRegistrationBrand: unique symbol = Symbol(
    "ProcessRegistration",
);

export type ProcessRegistration = Readonly<{
    identity: ProcessIdentity;
    retryPolicy: ProcessRetryPolicy;
    accept: (input: unknown) => ProcessRegistrationAcceptance;
    run: (
        acceptedInput: AcceptedProcessInput,
        context: ProcessRegistrationRunContext,
    ) => Promise<ProcessRegistrationCompletion>;
    [processRegistrationBrand]: true;
}>;

export function defineProcessRegistration<
    InputSchema extends z.ZodType,
    OutputSchema extends z.ZodType,
>(definition: {
    id: string;
    version: string;
    inputSchema: InputSchema;
    outputSchema: OutputSchema;
    activities?: readonly string[];
    retryPolicy?: ProcessRetryPolicy;
    execute: (
        input: z.output<InputSchema>,
        context: ProcessExecutionContext,
    ) => Promise<z.input<OutputSchema> | ExpectedProcessFailure>;
}): ProcessRegistration {
    assertProcessIdentity({ id: definition.id, version: definition.version });
    const inputSchema = definition.inputSchema;
    const outputSchema = definition.outputSchema;
    const execute = definition.execute;
    const retryPolicy = normalizeRetryPolicy(definition.retryPolicy);
    const activities = normalizeActivities(definition.activities);

    const identity = Object.freeze({
        id: definition.id,
        version: definition.version,
    });

    const accept = (input: unknown): ProcessRegistrationAcceptance => {
        const acceptedInput = inputSchema.safeParse(input);
        if (!acceptedInput.success) return Object.freeze({ accepted: false });

        const inputSnapshot = createJsonSnapshot(
            acceptedInput.data,
            inputMaxBytes,
        );
        if (!inputSnapshot.success) {
            return Object.freeze({ accepted: false });
        }
        const snapshot = createJsonSnapshot(
            {
                schemaVersion: 1,
                process: identity.id,
                version: identity.version,
                input: inputSnapshot.value,
            },
            acceptedMaxBytes,
        );
        if (!snapshot.success) {
            return Object.freeze({ accepted: false });
        }
        const acceptedSnapshot = parseAcceptedProcessInput(
            snapshot.value,
            identity,
        );
        if (!acceptedSnapshot) return Object.freeze({ accepted: false });

        return Object.freeze({
            accepted: true,
            acceptedInput: acceptedSnapshot,
        });
    };

    const run = (
        acceptedInput: AcceptedProcessInput,
        context: ProcessRegistrationRunContext,
    ): Promise<ProcessRegistrationCompletion> =>
        Promise.resolve()
            .then(() => {
                const snapshot = createJsonSnapshot(
                    acceptedInput,
                    acceptedMaxBytes,
                );
                const acceptedSnapshot = snapshot.success
                    ? parseAcceptedProcessInput(snapshot.value, identity)
                    : undefined;
                if (!acceptedSnapshot) {
                    throw new Error("Accepted Process input is invalid");
                }
                const executionInput =
                    acceptedSnapshot.input as z.output<InputSchema>;
                const runActivity: ProcessRunActivity =
                    context.runActivity ??
                    (async (_activity, operation) => operation());
                return execute(
                    executionInput,
                    Object.freeze({
                        runId: context.runId,
                        signal: context.signal,
                        runActivity: (activity, operation) => {
                            if (!activities.has(activity)) {
                                throw new Error(
                                    `Process activity ${activity} is not declared`,
                                );
                            }
                            return runActivity(activity, operation);
                        },
                    }),
                );
            })
            .then((rawOutput): ProcessRegistrationCompletion => {
                if (isExpectedProcessFailure(rawOutput)) {
                    return { status: "failed", error: rawOutput };
                }
                const output = outputSchema.safeParse(rawOutput);
                if (!output.success) {
                    return {
                        status: "failed",
                        error: {
                            code: "INVALID_OUTPUT",
                            publicMessage:
                                "The process produced an invalid output",
                        },
                    };
                }
                const outputSnapshot = createJsonSnapshot(
                    output.data,
                    outputMaxBytes,
                );
                if (!outputSnapshot.success) {
                    return {
                        status: "failed",
                        error: {
                            code: "INVALID_OUTPUT",
                            publicMessage:
                                "The process produced an invalid output",
                        },
                    };
                }
                return { status: "succeeded", output: outputSnapshot.value };
            });

    return Object.freeze({
        identity,
        retryPolicy,
        accept,
        run,
        [processRegistrationBrand]: true as const,
    });
}

function normalizeActivities(
    values: readonly string[] | undefined,
): ReadonlySet<string> {
    const activities = values ?? [];
    if (!Array.isArray(activities) || activities.length > 32) {
        throw new Error("Process activities must contain at most 32 names");
    }
    const names = new Set<string>();
    for (const activity of activities) {
        if (
            typeof activity !== "string" ||
            activity.length > 64 ||
            !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(activity)
        ) {
            throw new Error(
                "Process activity names must use lower snake case and contain at most 64 characters",
            );
        }
        if (names.has(activity)) {
            throw new Error(`Process activity ${activity} is duplicated`);
        }
        names.add(activity);
    }
    return names;
}

function normalizeRetryPolicy(
    policy: ProcessRetryPolicy | undefined,
): ProcessRetryPolicy {
    if (policy === undefined) return noRetryPolicy;
    if (
        !Number.isSafeInteger(policy.maximumAttempts) ||
        policy.maximumAttempts < 1 ||
        policy.maximumAttempts > 5
    ) {
        throw new Error(
            "Process retry maximum attempts must be between 1 and 5",
        );
    }
    if (
        !Array.isArray(policy.retryableErrorCodes) ||
        policy.retryableErrorCodes.some(
            (code) => code !== "AGENT_FAILURE" && code !== "DEPENDENCY_FAILURE",
        ) ||
        new Set(policy.retryableErrorCodes).size !==
            policy.retryableErrorCodes.length ||
        (policy.maximumAttempts > 1 && policy.retryableErrorCodes.length === 0)
    ) {
        throw new Error(
            "Process retry error codes must be unique expected failures",
        );
    }
    const initialDelayMs = positiveSafeInteger(
        policy.backoff?.initialDelayMs,
        "Process retry initial delay",
    );
    const maximumDelayMs = positiveSafeInteger(
        policy.backoff?.maximumDelayMs,
        "Process retry maximum delay",
    );
    if (maximumDelayMs < initialDelayMs || maximumDelayMs > 300_000) {
        throw new Error(
            "Process retry maximum delay must be between the initial delay and 300000",
        );
    }
    return Object.freeze({
        maximumAttempts: policy.maximumAttempts,
        retryableErrorCodes: Object.freeze([...policy.retryableErrorCodes]),
        backoff: Object.freeze({ initialDelayMs, maximumDelayMs }),
    });
}

function positiveSafeInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}

function isExpectedProcessFailure(
    value: unknown,
): value is ExpectedProcessFailure {
    return (
        typeof value === "object" &&
        value !== null &&
        expectedProcessFailureBrand in value &&
        value[expectedProcessFailureBrand] === true
    );
}

type JsonSnapshot =
    | Readonly<{ success: true; value: JsonValue }>
    | Readonly<{ success: false }>;

function createJsonSnapshot(value: unknown, maxBytes?: number): JsonSnapshot {
    if (!isJsonValue(value, new WeakSet<object>())) {
        return { success: false };
    }

    const serialized = JSON.stringify(value);
    if (
        maxBytes !== undefined &&
        Buffer.byteLength(serialized, "utf8") > maxBytes
    ) {
        return { success: false };
    }

    return {
        success: true,
        value: deepFreeze(JSON.parse(serialized) as JsonValue),
    };
}

function isJsonValue(
    value: unknown,
    seen: WeakSet<object>,
): value is JsonValue {
    if (
        value === null ||
        typeof value === "boolean" ||
        typeof value === "string"
    ) {
        return true;
    }
    if (typeof value === "number") {
        return Number.isFinite(value) && !Object.is(value, -0);
    }
    if (typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            if (Object.getPrototypeOf(value) !== Array.prototype) return false;
            const propertyNames = Object.getOwnPropertyNames(value);
            if (propertyNames.length !== value.length + 1) return false;
            if (Object.getOwnPropertySymbols(value).length > 0) return false;
            for (let index = 0; index < value.length; index += 1) {
                const descriptor = Object.getOwnPropertyDescriptor(
                    value,
                    String(index),
                );
                if (
                    !descriptor ||
                    !("value" in descriptor) ||
                    !descriptor.enumerable ||
                    !isJsonValue(descriptor.value, seen)
                ) {
                    return false;
                }
            }
            return true;
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return false;
        if (Object.getOwnPropertySymbols(value).length > 0) return false;
        for (const propertyName of Object.getOwnPropertyNames(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(
                value,
                propertyName,
            );
            if (
                !descriptor ||
                !("value" in descriptor) ||
                !descriptor.enumerable ||
                !isJsonValue(descriptor.value, seen)
            ) {
                return false;
            }
        }
        return true;
    } finally {
        seen.delete(value);
    }
}

function parseAcceptedProcessInput(
    value: JsonValue,
    identity: ProcessIdentity,
): AcceptedProcessInput | undefined {
    if (!isJsonObject(value)) return undefined;
    const properties = Object.keys(value);
    if (
        properties.length !== 4 ||
        !properties.includes("schemaVersion") ||
        !properties.includes("process") ||
        !properties.includes("version") ||
        !properties.includes("input") ||
        value.schemaVersion !== 1 ||
        value.process !== identity.id ||
        value.version !== identity.version
    ) {
        return undefined;
    }
    const inputSnapshot = createJsonSnapshot(value.input, inputMaxBytes);
    if (!inputSnapshot.success) return undefined;
    return value as AcceptedProcessInput;
}

function isJsonObject(
    value: JsonValue,
): value is Readonly<{ [key: string]: JsonValue }> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<Value>(value: Value, seen = new WeakSet<object>()): Value {
    if (typeof value !== "object" || value === null || seen.has(value)) {
        return value;
    }

    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && "value" in descriptor) {
            deepFreeze(descriptor.value, seen);
        }
    }
    return Object.freeze(value);
}

export function assertProcessIdentity(identity: ProcessIdentity): void {
    if (identity.id.trim().length === 0) {
        throw new Error("Business Process id must be non-empty");
    }
    if (identity.version.trim().length === 0) {
        throw new Error("Business Process version must be non-empty");
    }
    const serializedIdentity = JSON.stringify({
        process: identity.id,
        version: identity.version,
    });
    if (Buffer.byteLength(serializedIdentity, "utf8") > identityMaxBytes) {
        throw new Error(
            "Business Process identity must not exceed 4096 UTF-8 bytes",
        );
    }
}
