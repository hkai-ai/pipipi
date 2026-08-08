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

export type ProcessExecutionContext<Capabilities> = {
  capabilities: Capabilities;
  signal: AbortSignal;
};

export type ProcessDefinition<Capabilities> = {
  id: string;
  version: string;
  acceptsInput: (input: unknown) => boolean;
  execute: (
    input: unknown,
    context: ProcessExecutionContext<Capabilities>,
  ) => Promise<unknown>;
  parseOutput: (output: unknown) => ParseResult;
};

type ParseResult =
  | { success: true; data: unknown }
  | { success: false };

export function defineProcess<Input, Output, Capabilities>(definition: {
  id: string;
  version: string;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
  execute: (
    input: Input,
    context: ProcessExecutionContext<Capabilities>,
  ) => Promise<Output>;
}): ProcessDefinition<Capabilities> {
  return {
    id: definition.id,
    version: definition.version,
    acceptsInput: (input) => definition.inputSchema.safeParse(input).success,
    execute: async (input, context) =>
      definition.execute(definition.inputSchema.parse(input), context),
    parseOutput: (output) => {
      const result = definition.outputSchema.safeParse(output);
      return result.success
        ? { success: true, data: result.data }
        : { success: false };
    },
  };
}

export class ProcessRegistry<Capabilities> {
  readonly #processes = new Map<string, ProcessDefinition<Capabilities>>();

  constructor(processes: readonly ProcessDefinition<Capabilities>[] = []) {
    for (const process of processes) this.register(process);
  }

  register(process: ProcessDefinition<Capabilities>): void {
    const key = processKey(process.id, process.version);
    if (this.#processes.has(key)) {
      throw new Error(
        `Process ${process.id}/${process.version} is already registered`,
      );
    }
    this.#processes.set(key, process);
  }

  find(id: string, version: string): ProcessDefinition<Capabilities> | undefined {
    return this.#processes.get(processKey(id, version));
  }
}

export class ProcessFailure extends Error {
  constructor(
    readonly code: ProcessErrorCode,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "ProcessFailure";
  }
}

export class ProcessRunner<Capabilities> {
  readonly #registry: ProcessRegistry<Capabilities>;
  readonly #capabilities: Capabilities;
  readonly #processTimeoutMs: number;
  readonly #runRecords: ProcessRunRecords;

  constructor(options: {
    registry: ProcessRegistry<Capabilities>;
    capabilities: Capabilities;
    processTimeoutMs?: number;
    runRecords?: ProcessRunRecords;
  }) {
    this.#registry = options.registry;
    this.#capabilities = options.capabilities;
    this.#processTimeoutMs = options.processTimeoutMs ?? 30_000;
    this.#runRecords = options.runRecords ?? disabledProcessRunRecords;
  }

  async execute(rawRequest: unknown): Promise<ProcessRunResult> {
    const runId = randomUUID();
    const requestResult = executeRequestSchema.safeParse(rawRequest);
    if (!requestResult.success) {
      const identity = requestIdentitySchema.safeParse(rawRequest);
      return this.#complete(
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
    const process = this.#registry.find(request.process, request.version);
    if (!process) {
      return this.#complete(
        failure(
          runId,
          "PROCESS_NOT_FOUND",
          "The requested process version is not registered",
          identity,
        ),
      );
    }

    if (!process.acceptsInput(request.input)) {
      return this.#complete(
        failure(
          runId,
          "INVALID_INPUT",
          "The process input is invalid",
          identity,
        ),
      );
    }

    const result = await this.#executeAcceptedRequest({
      runId,
      request,
      process,
    });
    return this.#complete(result, { input: request.input });
  }

  async #executeAcceptedRequest(options: {
    runId: string;
    request: { process: string; version: string; input: unknown };
    process: ProcessDefinition<Capabilities>;
  }): Promise<ProcessRunResult> {
    const { runId, request, process } = options;
    const identity = {
      process: request.process,
      version: request.version,
    };

    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new ProcessTimeoutFailure());
      }, this.#processTimeoutMs);
    });

    try {
      const rawOutput = await Promise.race([
        process.execute(request.input, {
          capabilities: this.#capabilities,
          signal: controller.signal,
        }),
        timeoutFailure,
      ]);
      const output = process.parseOutput(rawOutput);
      if (!output.success) {
        return failure(
          runId,
          "INVALID_OUTPUT",
          "The process produced an invalid output",
          identity,
        );
      }

      return {
        runId,
        process: request.process,
        version: request.version,
        status: "succeeded",
        output: output.data,
      };
    } catch (error) {
      if (controller.signal.aborted || error instanceof ProcessTimeoutFailure) {
        return failure(
          runId,
          "PROCESS_TIMEOUT",
          "The process exceeded its time limit",
          identity,
        );
      }
      if (error instanceof ProcessFailure) {
        return failure(runId, error.code, error.publicMessage, identity);
      }
      return failure(
        runId,
        "INTERNAL_ERROR",
        "The process could not be completed",
        identity,
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  #complete(
    result: ProcessRunResult,
    acceptedRequest?: { input: unknown },
  ): ProcessRunResult {
    try {
      const recording = this.#runRecords.record({
        result,
        ...(acceptedRequest ? { acceptedRequest } : {}),
      });
      if (recording) void recording.catch(() => {});
    } catch {
      // Run recording is best-effort and cannot change the process result.
    }
    return result;
  }
}

class ProcessTimeoutFailure extends Error {}

function processKey(id: string, version: string): string {
  return `${id}\0${version}`;
}

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
