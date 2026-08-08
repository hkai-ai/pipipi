import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  disabledProcessRunRecords,
  type ProcessRunRecords,
} from "./process-run-records.js";

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

export type ProcessRegistrationStart =
  | Readonly<{ accepted: false }>
  | Readonly<{
      accepted: true;
      completion: Promise<ProcessRegistrationCompletion>;
    }>;

const processRegistrationBrand: unique symbol = Symbol("ProcessRegistration");

export type ProcessRegistration = Readonly<{
  identity: ProcessIdentity;
  start: (
    input: unknown,
    context: ProcessExecutionContext,
  ) => ProcessRegistrationStart;
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
  execute: (
    input: z.output<InputSchema>,
    context: ProcessExecutionContext,
  ) => Promise<z.input<OutputSchema> | ExpectedProcessFailure>;
}): ProcessRegistration {
  assertProcessIdentity({ id: definition.id, version: definition.version });
  const inputSchema = definition.inputSchema;
  const outputSchema = definition.outputSchema;
  const execute = definition.execute;

  const identity = Object.freeze({
    id: definition.id,
    version: definition.version,
  });

  return Object.freeze({
    identity,
    start: (input, context) => {
      const acceptedInput = inputSchema.safeParse(input);
      if (!acceptedInput.success) return Object.freeze({ accepted: false });

      const completion = Promise.resolve()
        .then(() => execute(acceptedInput.data, context))
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
          return { status: "succeeded", output: output.data };
        });

      return Object.freeze({ accepted: true, completion });
    },
    [processRegistrationBrand]: true as const,
  });
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

function assertProcessIdentity(identity: ProcessIdentity): void {
  if (identity.id.trim().length === 0) {
    throw new Error("Business Process id must be non-empty");
  }
  if (identity.version.trim().length === 0) {
    throw new Error("Business Process version must be non-empty");
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
  const processTimeoutMs = options.processTimeoutMs ?? 30_000;
  if (!Number.isInteger(processTimeoutMs) || processTimeoutMs < 1) {
    throw new Error("Process timeout must be a positive integer");
  }

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

      const controller = new AbortController();
      let started: ProcessRegistrationStart;
      try {
        started = registration.start(request.input, {
          runId,
          signal: controller.signal,
        });
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

      if (!started.accepted) {
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

      let result: ProcessRunResult;
      let timeout: NodeJS.Timeout | undefined;
      const timeoutFailure = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new ProcessTimeoutFailure());
        }, processTimeoutMs);
      });
      try {
        const completion = await Promise.race([
          started.completion,
          timeoutFailure,
        ]);
        result =
          completion.status === "succeeded"
            ? {
                runId,
                process: request.process,
                version: request.version,
                status: "succeeded",
                output: completion.output,
              }
            : failure(
                runId,
                completion.error.code,
                completion.error.publicMessage,
                identity,
              );
      } catch (error) {
        result =
          controller.signal.aborted || error instanceof ProcessTimeoutFailure
            ? failure(
                runId,
                "PROCESS_TIMEOUT",
                "The process exceeded its time limit",
                identity,
              )
            : failure(
                runId,
                "INTERNAL_ERROR",
                "The process could not be completed",
                identity,
              );
      } finally {
        if (timeout) clearTimeout(timeout);
      }

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
