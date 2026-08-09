import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  disabledProcessRunRecords,
  type ProcessRunRecords,
} from "./process-run-records.js";

const acceptedProcessInputPayloadMaxBytes = 262_144;
const acceptedProcessOutputMaxBytes = 262_144;
const acceptedProcessInputMetadataMaxBytes = 4_096;
const acceptedProcessInputEnvelopeOverheadBytes = 27;
const acceptedProcessInputMaxBytes =
  acceptedProcessInputPayloadMaxBytes +
  acceptedProcessInputMetadataMaxBytes +
  acceptedProcessInputEnvelopeOverheadBytes;

const executeRequestSchema = z.strictObject({
  process: z.string().min(1),
  version: z.string().min(1),
  input: z.unknown(),
});

const requestIdentitySchema = z.object({
  process: z.string(),
  version: z.string(),
});

export type ProcessErrorCode =
  | "AGENT_FAILURE"
  | "DEPENDENCY_FAILURE"
  | "INTERNAL_ERROR"
  | "INVALID_INPUT"
  | "INVALID_OUTPUT"
  | "PROCESS_NOT_FOUND"
  | "PROCESS_TIMEOUT";

export type ProcessRunResult =
  | {
      runId: string;
      process: string;
      version: string;
      status: "succeeded";
      output: unknown;
    }
  | {
      runId: string;
      process?: string;
      version?: string;
      status: "failed";
      error: {
        code: ProcessErrorCode;
        message: string;
      };
    };

export type ProcessIdentity = Readonly<{
  id: string;
  version: string;
}>;

export type ProcessExecutionContext = Readonly<{
  runId: string;
  signal: AbortSignal;
}>;

export type ExpectedProcessErrorCode =
  | "AGENT_FAILURE"
  | "DEPENDENCY_FAILURE";

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

const processRegistrationBrand: unique symbol = Symbol("ProcessRegistration");

export type ProcessRegistration = Readonly<{
  identity: ProcessIdentity;
  retryPolicy: ProcessRetryPolicy;
  accept: (input: unknown) => ProcessRegistrationAcceptance;
  run: (
    acceptedInput: AcceptedProcessInput,
    context: ProcessExecutionContext,
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

  const identity = Object.freeze({
    id: definition.id,
    version: definition.version,
  });

  const accept = (input: unknown): ProcessRegistrationAcceptance => {
    const acceptedInput = inputSchema.safeParse(input);
    if (!acceptedInput.success) return Object.freeze({ accepted: false });

    const inputSnapshot = createJsonSnapshot(
      acceptedInput.data,
      acceptedProcessInputPayloadMaxBytes,
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
      acceptedProcessInputMaxBytes,
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
    context: ProcessExecutionContext,
  ): Promise<ProcessRegistrationCompletion> =>
    Promise.resolve()
      .then(() => {
        const snapshot = createJsonSnapshot(
          acceptedInput,
          acceptedProcessInputMaxBytes,
        );
        const acceptedSnapshot = snapshot.success
          ? parseAcceptedProcessInput(snapshot.value, identity)
          : undefined;
        if (!acceptedSnapshot) {
          throw new Error("Accepted Process input is invalid");
        }
        const executionInput = acceptedSnapshot.input as z.output<InputSchema>;
        return execute(executionInput, context);
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
              publicMessage: "The process produced an invalid output",
            },
          };
        }
        const outputSnapshot = createJsonSnapshot(
          output.data,
          acceptedProcessOutputMaxBytes,
        );
        if (!outputSnapshot.success) {
          return {
            status: "failed",
            error: {
              code: "INVALID_OUTPUT",
              publicMessage: "The process produced an invalid output",
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

function normalizeRetryPolicy(
  policy: ProcessRetryPolicy | undefined,
): ProcessRetryPolicy {
  if (policy === undefined) return noRetryPolicy;
  if (
    !Number.isSafeInteger(policy.maximumAttempts) ||
    policy.maximumAttempts < 1 ||
    policy.maximumAttempts > 5
  ) {
    throw new Error("Process retry maximum attempts must be between 1 and 5");
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
    throw new Error("Process retry error codes must be unique expected failures");
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
      const descriptor = Object.getOwnPropertyDescriptor(value, propertyName);
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
  const inputSnapshot = createJsonSnapshot(
    value.input,
    acceptedProcessInputPayloadMaxBytes,
  );
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

function assertProcessIdentity(identity: ProcessIdentity): void {
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
  if (
    Buffer.byteLength(serializedIdentity, "utf8") >
    acceptedProcessInputMetadataMaxBytes
  ) {
    throw new Error(
      "Business Process identity must not exceed 4096 UTF-8 bytes",
    );
  }
}

const processRegistryBrand: unique symbol = Symbol("ProcessRegistry");

export type ProcessRegistry = Readonly<{
  find: (identity: ProcessIdentity) => ProcessRegistration | undefined;
  [processRegistryBrand]: true;
}>;

export function createProcessRegistry(
  registrations: readonly ProcessRegistration[],
): ProcessRegistry {
  const registrationsById = new Map<
    string,
    Map<string, ProcessRegistration>
  >();

  for (const registration of registrations) {
    if (
      typeof registration !== "object" ||
      registration === null ||
      registration[processRegistrationBrand] !== true
    ) {
      throw new Error("Process Registry accepts only Process Registrations");
    }
    assertProcessIdentity(registration.identity);
    let versions = registrationsById.get(registration.identity.id);
    if (!versions) {
      versions = new Map();
      registrationsById.set(registration.identity.id, versions);
    }
    if (versions.has(registration.identity.version)) {
      throw new Error(
        `Process ${registration.identity.id}/${registration.identity.version} is registered more than once`,
      );
    }
    versions.set(registration.identity.version, registration);
  }

  return Object.freeze({
    find: (identity: ProcessIdentity) =>
      registrationsById.get(identity.id)?.get(identity.version),
    [processRegistryBrand]: true as const,
  });
}

export type ProcessAttemptRequest = Readonly<{
  runId: string;
  registration: ProcessRegistration;
  acceptedInput: AcceptedProcessInput;
  signal?: AbortSignal;
}>;

export type ProcessAttemptRunner = Readonly<{
  run: (attempt: ProcessAttemptRequest) => Promise<ProcessRunResult>;
}>;

export function createProcessAttemptRunner(
  options: { processTimeoutMs?: number } = {},
): ProcessAttemptRunner {
  const processTimeoutMs = options.processTimeoutMs ?? 30_000;
  if (!Number.isInteger(processTimeoutMs) || processTimeoutMs < 1) {
    throw new Error("Process timeout must be a positive integer");
  }

  return Object.freeze({
    run: async (attempt): Promise<ProcessRunResult> => {
      const identity = {
        process: attempt.registration.identity.id,
        version: attempt.registration.identity.version,
      };
      const controller = new AbortController();
      let timeout: NodeJS.Timeout | undefined;
      let externallyCancelled = false;
      let removeCancellationListener: (() => void) | undefined;
      const timeoutFailure = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new ProcessTimeoutFailure());
        }, processTimeoutMs);
      });
      const cancellationFailure = new Promise<never>((_resolve, reject) => {
        const cancel = () => {
          externallyCancelled = true;
          controller.abort(attempt.signal?.reason);
          reject(new ProcessAttemptCancelledFailure());
        };
        if (attempt.signal?.aborted) {
          cancel();
          return;
        }
        attempt.signal?.addEventListener("abort", cancel, { once: true });
        removeCancellationListener = () =>
          attempt.signal?.removeEventListener("abort", cancel);
      });

      try {
        const completion = await Promise.race([
          attempt.registration.run(attempt.acceptedInput, {
            runId: attempt.runId,
            signal: controller.signal,
          }),
          timeoutFailure,
          cancellationFailure,
        ]);
        return completion.status === "succeeded"
          ? {
              runId: attempt.runId,
              ...identity,
              status: "succeeded",
              output: completion.output,
            }
          : failure(
              attempt.runId,
              completion.error.code,
              completion.error.publicMessage,
              identity,
            );
      } catch (error) {
        if (
          externallyCancelled ||
          error instanceof ProcessAttemptCancelledFailure
        ) {
          return failure(
            attempt.runId,
            "INTERNAL_ERROR",
            "The process could not be completed",
            identity,
          );
        }
        if (
          controller.signal.aborted ||
          error instanceof ProcessTimeoutFailure
        ) {
          return failure(
            attempt.runId,
            "PROCESS_TIMEOUT",
            "The process exceeded its time limit",
            identity,
          );
        }
        return failure(
          attempt.runId,
          "INTERNAL_ERROR",
          "The process could not be completed",
          identity,
        );
      } finally {
        if (timeout) clearTimeout(timeout);
        removeCancellationListener?.();
      }
    },
  });
}

export type ProcessExecutor = Readonly<{
  execute: (request: unknown) => Promise<ProcessRunResult>;
}>;

export function createProcessRunner(options: {
  registry: ProcessRegistry;
  processTimeoutMs?: number;
  runRecords?: ProcessRunRecords;
}): ProcessExecutor {
  const registry = options.registry;
  if (
    typeof registry !== "object" ||
    registry === null ||
    registry[processRegistryBrand] !== true
  ) {
    throw new Error("Process Runner requires a Process Registry");
  }
  const runRecords = options.runRecords ?? disabledProcessRunRecords;
  const attemptRunner = createProcessAttemptRunner({
    processTimeoutMs: options.processTimeoutMs,
  });

  return Object.freeze({
    execute: async (rawRequest: unknown): Promise<ProcessRunResult> => {
      const runId = randomUUID();
      const requestResult = executeRequestSchema.safeParse(rawRequest);
      if (!requestResult.success) {
        const identity = requestIdentitySchema.safeParse(rawRequest);
        return completeProcessRun(
          runRecords,
          failure(runId, "INVALID_INPUT", "The process input is invalid", {
            ...(identity.success ? identity.data : {}),
          }),
        );
      }

      const request = requestResult.data;
      const identity = {
        process: request.process,
        version: request.version,
      };
      const registration = registry.find({
        id: request.process,
        version: request.version,
      });
      if (!registration) {
        return completeProcessRun(
          runRecords,
          failure(
            runId,
            "PROCESS_NOT_FOUND",
            "The requested process version is not registered",
            identity,
          ),
        );
      }

      let acceptance: ProcessRegistrationAcceptance;
      try {
        acceptance = registration.accept(request.input);
      } catch {
        return completeProcessRun(
          runRecords,
          failure(
            runId,
            "INTERNAL_ERROR",
            "The process could not be completed",
            identity,
          ),
        );
      }

      if (!acceptance.accepted) {
        return completeProcessRun(
          runRecords,
          failure(
            runId,
            "INVALID_INPUT",
            "The process input is invalid",
            identity,
          ),
        );
      }

      const result = await attemptRunner.run({
        runId,
        registration,
        acceptedInput: acceptance.acceptedInput,
      });

      return completeProcessRun(runRecords, result, {
        input: request.input,
      });
    },
  });
}

function completeProcessRun(
  runRecords: ProcessRunRecords,
  result: ProcessRunResult,
  acceptedRequest?: { input: unknown },
): ProcessRunResult {
  try {
    const recording = runRecords.record({
      result,
      ...(acceptedRequest ? { acceptedRequest } : {}),
    });
    if (recording) void recording.catch(() => {});
  } catch {
    // Run recording is best-effort and cannot change the process result.
  }
  return result;
}

class ProcessTimeoutFailure extends Error {}

class ProcessAttemptCancelledFailure extends Error {}

function failure(
  runId: string,
  code: ProcessErrorCode,
  message: string,
  identity: { process?: string; version?: string } = {},
): ProcessRunResult {
  return {
    runId,
    ...identity,
    status: "failed",
    error: { code, message },
  };
}
