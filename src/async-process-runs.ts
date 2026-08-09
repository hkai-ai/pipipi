import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ProcessErrorCode,
  ProcessRegistry,
} from "./process-runtime.js";
import type {
  ProcessRunStore,
  StoredProcessRun,
} from "./process-run-store.js";
import type { ProcessWorkQueue } from "./process-work-queue.js";

const processRunRequestSchema = z.strictObject({
  process: z.string().min(1),
  version: z.string().min(1),
  input: z.unknown(),
});

export type ProcessRunView =
  | Readonly<{
      runId: string;
      process: string;
      version: string;
      status: "queued";
      createdAt: string;
    }>
  | Readonly<{
      runId: string;
      process: string;
      version: string;
      status: "running";
      createdAt: string;
      startedAt: string;
    }>
  | Readonly<{
      runId: string;
      process: string;
      version: string;
      status: "succeeded";
      createdAt: string;
      startedAt: string;
      finishedAt: string;
      output: unknown;
    }>
  | Readonly<{
      runId: string;
      process: string;
      version: string;
      status: "failed";
      createdAt: string;
      startedAt: string;
      finishedAt: string;
      error: Readonly<{
        code: ProcessErrorCode;
        message: string;
      }>;
    }>;

export type ProcessRunSubmission =
  | Readonly<{
      accepted: true;
      runId: string;
      process: string;
      version: string;
      status: "queued";
      createdAt: string;
    }>
  | Readonly<{
      accepted: false;
      error: Readonly<{
        code:
          | "INVALID_INPUT"
          | "PROCESS_NOT_FOUND"
          | "IDEMPOTENCY_CONFLICT";
        message: string;
      }>;
    }>;

export type AsyncProcessRuns = Readonly<{
  submit: (
    request: unknown,
    context: Readonly<{ callerId: string; idempotencyKey: string }>,
  ) => Promise<ProcessRunSubmission>;
  find: (
    runId: string,
    context: Readonly<{ callerId: string }>,
  ) => Promise<ProcessRunView | undefined>;
}>;

export function createAsyncProcessRuns(options: {
  registry: ProcessRegistry;
  store: ProcessRunStore;
  queue: ProcessWorkQueue;
  clock?: () => string;
  createRunId?: () => string;
}): AsyncProcessRuns {
  const registry = options.registry;
  const store = options.store;
  const queue = options.queue;
  const clock = options.clock ?? (() => new Date().toISOString());
  const createRunId = options.createRunId ?? randomUUID;

  return Object.freeze({
    submit: async (rawRequest, context) => {
      assertContextValue("callerId", context.callerId);
      assertContextValue("idempotencyKey", context.idempotencyKey);

      const requestResult = processRunRequestSchema.safeParse(rawRequest);
      if (!requestResult.success) {
        return rejected(
          "INVALID_INPUT",
          "The process input is invalid",
        );
      }
      const request = requestResult.data;
      const registration = registry.find({
        id: request.process,
        version: request.version,
      });
      if (!registration) {
        return rejected(
          "PROCESS_NOT_FOUND",
          "The requested process version is not registered",
        );
      }

      const acceptance = registration.accept(request.input);
      if (!acceptance.accepted) {
        return rejected(
          "INVALID_INPUT",
          "The process input is invalid",
        );
      }

      const storeResult = await store.accept({
        runId: createRunId(),
        ownerId: context.callerId,
        idempotencyKey: context.idempotencyKey,
        requestFingerprint: fingerprint(acceptance.acceptedInput),
        process: request.process,
        version: request.version,
        acceptedInput: acceptance.acceptedInput,
        createdAt: clock(),
      });
      if (storeResult.outcome === "conflict") {
        return rejected(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key was already used for a different request",
        );
      }

      const run = storeResult.run;
      if (storeResult.outcome === "created") {
        await queue.enqueue({ schemaVersion: 1, runId: run.runId });
      }
      return Object.freeze({
        accepted: true,
        runId: run.runId,
        process: run.process,
        version: run.version,
        status: "queued",
        createdAt: run.createdAt,
      });
    },

    find: async (runId, context) => {
      assertContextValue("callerId", context.callerId);
      const run = await store.findOwned(runId, context.callerId);
      return run ? toProcessRunView(run) : undefined;
    },
  });
}

function rejected(
  code: Extract<
    ProcessRunSubmission,
    { accepted: false }
  >["error"]["code"],
  message: string,
): ProcessRunSubmission {
  return Object.freeze({
    accepted: false,
    error: Object.freeze({ code, message }),
  });
}

function toProcessRunView(run: StoredProcessRun): ProcessRunView {
  const identity = {
    runId: run.runId,
    process: run.process,
    version: run.version,
    createdAt: run.createdAt,
  };
  switch (run.status) {
    case "queued":
      return { ...identity, status: "queued" };
    case "running":
      return { ...identity, status: "running", startedAt: run.startedAt };
    case "succeeded":
      return {
        ...identity,
        status: "succeeded",
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        output: structuredClone(run.output),
      };
    case "failed":
      return {
        ...identity,
        status: "failed",
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        error: structuredClone(run.error),
      };
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(
      ([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`,
    )
    .join(",")}}`;
}

function assertContextValue(
  name: "callerId" | "idempotencyKey",
  value: string,
): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > 512
  ) {
    throw new Error(`${name} must be a non-empty string of at most 512 bytes`);
  }
}
