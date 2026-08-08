import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type { CompletedProcessRun } from "../src/process-run-records.js";
import {
  createProcessRegistry,
  createProcessRunner,
  defineProcessRegistration,
  failProcess,
  type ProcessExecutionContext,
  type ProcessRegistry,
} from "../src/process-runtime.js";

describe("Process Runtime", () => {
  it("builds an immutable catalog with exact Business Process versions", async () => {
    const v1 = registration("v1");
    const v2 = registration("v2");
    const source = [v1, v2];
    const registry = createProcessRegistry(source);

    source.splice(0, source.length, registration("v3"));

    expect(
      registry.find({ id: "test-processing", version: "v1" }),
    ).toBe(v1);
    expect(
      registry.find({ id: "test-processing", version: "v2" }),
    ).toBe(v2);
    expect(
      registry.find({ id: "test-processing", version: "v3" }),
    ).toBeUndefined();
    expect(
      registry.find({ id: "test-processing", version: "latest" }),
    ).toBeUndefined();

    const executor = createProcessRunner({ registry });
    await expect(
      executor.execute({
        process: "test-processing",
        version: "v2",
        input: { value: "request" },
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      output: { value: "v2:request" },
    });
    await expect(
      executor.execute({
        process: "test-processing",
        version: "latest",
        input: { value: "request" },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "PROCESS_NOT_FOUND" },
    });
  });

  it("captures the Process Definition at Registration creation", async () => {
    const definition = {
      id: "test-processing",
      version: "v1",
      inputSchema: z.strictObject({ value: z.string() }),
      outputSchema: z.strictObject({ value: z.string() }),
      execute: async (input: { value: string }) => ({
        value: `original:${input.value}`,
      }),
    };
    const process = defineProcessRegistration(definition);
    const executor = createProcessRunner({
      registry: createProcessRegistry([process]),
    });

    definition.execute = async (input) => ({
      value: `rebound:${input.value}`,
    });

    await expect(
      executor.execute({
        process: "test-processing",
        version: "v1",
        input: { value: "request" },
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      output: { value: "original:request" },
    });
  });

  it("captures the Process Registry at Runner creation", async () => {
    const options = {
      registry: createProcessRegistry([registration("v1")]),
    };
    const executor = createProcessRunner(options);

    options.registry = createProcessRegistry([
      defineProcessRegistration({
        id: "test-processing",
        version: "v1",
        inputSchema: z.strictObject({ value: z.string() }),
        outputSchema: z.strictObject({ value: z.string() }),
        execute: async () => ({ value: "rebound" }),
      }),
    ]);

    await expect(
      executor.execute({
        process: "test-processing",
        version: "v1",
        input: { value: "request" },
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      output: { value: "v1:request" },
    });
  });

  it("rejects invalid Process Registration identities at startup", () => {
    expect(() => createProcessRegistry([registration("v1", " ")])).toThrow(
      "Business Process id must be non-empty",
    );
    expect(() => createProcessRegistry([registration(" ")])).toThrow(
      "Business Process version must be non-empty",
    );
  });

  it("rejects duplicate Business Process versions at startup", () => {
    expect(() =>
      createProcessRegistry([registration("v1"), registration("v1")]),
    ).toThrow("Process test-processing/v1 is registered more than once");
  });

  it("rejects a forged Process Registry at Runner startup", () => {
    const fallback = registration("v1");

    expect(() =>
      createProcessRunner({
        registry: {
          find: () => fallback,
        } as unknown as ProcessRegistry,
      }),
    ).toThrow("Process Runner requires a Process Registry");
  });

  it("carries an expected Process Definition failure as a value", async () => {
    const process = defineProcessRegistration({
      id: "test-processing",
      version: "v1",
      inputSchema: z.strictObject({ value: z.string() }),
      outputSchema: z.strictObject({ value: z.string() }),
      execute: async () =>
        failProcess(
          "DEPENDENCY_FAILURE",
          "A required business service is unavailable",
        ),
    });

    const started = process.start(
      { value: "request" },
      {
        runId: "00000000-0000-4000-8000-000000000001",
        signal: new AbortController().signal,
      },
    );

    expect(started.accepted).toBe(true);
    if (!started.accepted) throw new Error("Expected accepted input");
    expect(await started.completion).toMatchObject({
      status: "failed",
      error: {
        code: "DEPENDENCY_FAILURE",
        publicMessage: "A required business service is unavailable",
      },
    });
  });

  it("starts accepted work without waiting for the completion promise", async () => {
    let executionCalls = 0;
    const process = defineProcessRegistration({
      id: "test-processing",
      version: "v1",
      inputSchema: z.strictObject({ value: z.string() }),
      outputSchema: z.strictObject({ value: z.string() }),
      execute: async (input) => {
        expectTypeOf(input).toEqualTypeOf<{ value: string }>();
        executionCalls += 1;
        return input;
      },
    });

    const started = process.start(
      { value: "request" },
      {
        runId: "00000000-0000-4000-8000-000000000001",
        signal: new AbortController().signal,
      },
    );

    expect(started.accepted).toBe(true);
    await Promise.resolve();
    expect(executionCalls).toBe(1);
    if (!started.accepted) throw new Error("Expected accepted input");
    await expect(started.completion).resolves.toEqual({
      status: "succeeded",
      output: { value: "request" },
    });
  });

  it("binds a narrow dependency and stable policy in the Registration factory", async () => {
    const dependencyInputs: string[] = [];
    const textProcessing = {
      process: async (value: string, options: { signal: AbortSignal }) => {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        dependencyInputs.push(value);
        return value.toUpperCase();
      },
    };
    const prefix = "approved:";
    const process = createTestProcessingRegistration({
      version: "v1",
      prefix,
      textProcessing,
    });
    const executor = createProcessRunner({
      registry: createProcessRegistry([process]),
    });

    const result = await executor.execute({
      process: "test-processing",
      version: "v1",
      input: { value: "request" },
    });

    expect(result).toMatchObject({
      status: "succeeded",
      output: { value: "approved:REQUEST" },
    });
    expect(dependencyInputs).toEqual(["request"]);
  });

  it("executes an accepted input once and records its original value", async () => {
    let inputParses = 0;
    let executionRunId: string | undefined;
    const completions: CompletedProcessRun[] = [];
    const process = defineProcessRegistration({
      id: "test-processing",
      version: "v1",
      inputSchema: z
        .strictObject({ value: z.string() })
        .transform((input) => {
          inputParses += 1;
          return { value: input.value.trim() };
        }),
      outputSchema: z.strictObject({ value: z.string() }),
      execute: async (input, context) => {
        executionRunId = context.runId;
        return { value: input.value.toUpperCase() };
      },
    });
    const executor = createProcessRunner({
      registry: createProcessRegistry([process]),
      runRecords: {
        record: (completion) => {
          completions.push(completion);
        },
        find: async () => undefined,
      },
    });

    const result = await executor.execute({
      process: "test-processing",
      version: "v1",
      input: { value: " request " },
    });

    expect(result).toEqual({
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      process: "test-processing",
      version: "v1",
      status: "succeeded",
      output: { value: "REQUEST" },
    });
    expect(inputParses).toBe(1);
    expect(executionRunId).toBe(result.runId);
    expect(completions).toEqual([
      {
        result,
        acceptedRequest: { input: { value: " request " } },
      },
    ]);
  });

  it("aborts an accepted Process Registration when its time limit expires", async () => {
    let executionWasAborted = false;
    const completions: CompletedProcessRun[] = [];
    const process = defineProcessRegistration({
      id: "test-processing",
      version: "v1",
      inputSchema: z.strictObject({ value: z.string() }),
      outputSchema: z.strictObject({ value: z.string() }),
      execute: async (_input, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener("abort", () => {
            executionWasAborted = true;
          });
          setTimeout(() => resolve({ value: "late" }), 50);
        }),
    });
    const executor = createProcessRunner({
      registry: createProcessRegistry([process]),
      processTimeoutMs: 5,
      runRecords: {
        record: (completion) => {
          completions.push(completion);
        },
        find: async () => undefined,
      },
    });

    const result = await executor.execute({
      process: "test-processing",
      version: "v1",
      input: { value: "request" },
    });

    expect(result).toMatchObject({
      process: "test-processing",
      version: "v1",
      status: "failed",
      error: {
        code: "PROCESS_TIMEOUT",
        message: "The process exceeded its time limit",
      },
    });
    expect(executionWasAborted).toBe(true);
    expect(completions).toEqual([
      {
        result,
        acceptedRequest: { input: { value: "request" } },
      },
    ]);
  });

  it("records rejected envelope and business input without their content", async () => {
    let executionCalls = 0;
    const completions: CompletedProcessRun[] = [];
    const process = defineProcessRegistration({
      id: "test-processing",
      version: "v1",
      inputSchema: z.strictObject({ value: z.string().trim().min(1) }),
      outputSchema: z.strictObject({ value: z.string() }),
      execute: async (input) => {
        executionCalls += 1;
        return input;
      },
    });
    const executor = createProcessRunner({
      registry: createProcessRegistry([process]),
      runRecords: {
        record: (completion) => {
          completions.push(completion);
        },
        find: async () => undefined,
      },
    });

    const result = await executor.execute({
      process: "test-processing",
      version: "v1",
      input: { value: " " },
    });
    const envelopeResult = await executor.execute({
      process: "test-processing",
      version: "v1",
      input: { value: "request" },
      steps: [{ endpoint: "https://untrusted.example" }],
    });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "INVALID_INPUT" },
    });
    expect(envelopeResult).toMatchObject({
      status: "failed",
      error: { code: "INVALID_INPUT" },
    });
    expect(executionCalls).toBe(0);
    expect(completions).toEqual([{ result }, { result: envelopeResult }]);
  });

  it("maps an expected Process Definition failure without losing accepted input", async () => {
    const completions: CompletedProcessRun[] = [];
    const process = defineProcessRegistration({
      id: "test-processing",
      version: "v1",
      inputSchema: z.strictObject({ value: z.string() }),
      outputSchema: z.strictObject({ value: z.string() }),
      execute: async () =>
        failProcess(
          "DEPENDENCY_FAILURE",
          "A required business service is unavailable",
        ),
    });
    const executor = createProcessRunner({
      registry: createProcessRegistry([process]),
      runRecords: {
        record: (completion) => {
          completions.push(completion);
        },
        find: async () => undefined,
      },
    });

    const result = await executor.execute({
      process: "test-processing",
      version: "v1",
      input: { value: "request" },
    });

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "DEPENDENCY_FAILURE",
        message: "A required business service is unavailable",
      },
    });
    expect(completions).toEqual([
      {
        result,
        acceptedRequest: { input: { value: "request" } },
      },
    ]);
  });

  it("maps invalid output without losing accepted input", async () => {
    const completions: CompletedProcessRun[] = [];
    const process = defineProcessRegistration({
      id: "test-processing",
      version: "v1",
      inputSchema: z.strictObject({ value: z.string() }),
      outputSchema: z.strictObject({ value: z.string().min(1) }),
      execute: async () => ({ value: "" }),
    });
    const executor = createProcessRunner({
      registry: createProcessRegistry([process]),
      runRecords: recordsInto(completions),
    });

    const result = await executor.execute({
      process: "test-processing",
      version: "v1",
      input: { value: "request" },
    });

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "INVALID_OUTPUT",
        message: "The process produced an invalid output",
      },
    });
    expect(completions).toEqual([
      {
        result,
        acceptedRequest: { input: { value: "request" } },
      },
    ]);
  });

  it("sanitizes an unexpected failure without losing accepted input", async () => {
    const completions: CompletedProcessRun[] = [];
    const process = defineProcessRegistration({
      id: "test-processing",
      version: "v1",
      inputSchema: z.strictObject({ value: z.string() }),
      outputSchema: z.strictObject({ value: z.string() }),
      execute: async () => {
        throw new Error("private implementation detail");
      },
    });
    const executor = createProcessRunner({
      registry: createProcessRegistry([process]),
      runRecords: recordsInto(completions),
    });

    const result = await executor.execute({
      process: "test-processing",
      version: "v1",
      input: { value: "request" },
    });

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "INTERNAL_ERROR",
        message: "The process could not be completed",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private implementation detail");
    expect(completions).toEqual([
      {
        result,
        acceptedRequest: { input: { value: "request" } },
      },
    ]);
  });
});

function registration(version: string, id = "test-processing") {
  return defineProcessRegistration({
    id,
    version,
    inputSchema: z.strictObject({ value: z.string() }),
    outputSchema: z.strictObject({ value: z.string() }),
    execute: async (input) => ({ value: `${version}:${input.value}` }),
  });
}

function recordsInto(completions: CompletedProcessRun[]) {
  return {
    record: (completion: CompletedProcessRun) => {
      completions.push(completion);
    },
    find: async () => undefined,
  };
}

function createTestProcessingRegistration(options: {
  version: string;
  prefix: string;
  textProcessing: {
    process: (
      value: string,
      options: { signal: AbortSignal },
    ) => Promise<string>;
  };
}) {
  return defineProcessRegistration({
    id: "test-processing",
    version: options.version,
    inputSchema: z.strictObject({ value: z.string() }),
    outputSchema: z.strictObject({ value: z.string() }),
    execute: async (input, context) => {
      expectTypeOf(input).toEqualTypeOf<{ value: string }>();
      expectTypeOf(context).toEqualTypeOf<ProcessExecutionContext>();
      const processed = await options.textProcessing.process(input.value, {
        signal: context.signal,
      });
      const output = { value: `${options.prefix}${processed}` };
      expectTypeOf(output).toEqualTypeOf<{ value: string }>();
      return output;
    },
  });
}
