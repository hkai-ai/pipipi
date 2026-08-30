/** 为受限 Agent 提供精确 Process Tool 解析、Schema 推导、稳定子 Run 与 Attempt 执行治理 */
import { z } from "zod";
import type {
    JsonValue,
    ProcessAttemptRunner,
    ProcessErrorCode,
    ProcessIdentity,
    ProcessRegistration,
    ProcessRegistry,
} from "../process-runtime/index.js";

export type ProcessToolSideEffect = "none" | "priced";

export type ProcessToolSpec = Readonly<{
    process: string;
    version: string;
    toolName: string;
    description: string;
    sideEffect: ProcessToolSideEffect;
}>;

export type ProcessToolDescriptor = Readonly<{
    name: string;
    description: string;
    parameters: Readonly<Record<string, unknown>>;
}>;

export type ProcessToolInvocation = Readonly<{
    invocation: number;
    process: string;
    version: string;
    sideEffect: ProcessToolSideEffect;
    status: "succeeded" | "failed";
    output?: JsonValue;
    error?: Readonly<{ code: ProcessErrorCode; message: string }>;
}>;

export type ProcessToolRuntime = Readonly<{
    specs: readonly ProcessToolSpec[];
    descriptors: readonly ProcessToolDescriptor[];
    invoke: (
        request: ProcessToolInvocationRequest,
    ) => Promise<ProcessToolInvocation>;
}>;

export type ProcessToolInvocationRequest = Readonly<{
    toolName: string;
    input: unknown;
    parentRunId: string;
    invocation: number;
    signal: AbortSignal;
}>;

export type ProcessToolRuntimeOptions = Readonly<{
    specs: readonly ProcessToolSpec[];
    registry: ProcessRegistry;
    attemptRunner: ProcessAttemptRunner;
    owner?: ProcessIdentity;
}>;

const toolNamePattern = /^[a-z][a-z0-9_]{0,63}$/;

export function createProcessToolRuntime(
    options: ProcessToolRuntimeOptions,
): ProcessToolRuntime {
    if (!Array.isArray(options.specs) || options.specs.length === 0) {
        throw new Error("Process Tool Runtime requires at least one Tool");
    }

    const names = new Set<string>();
    const identities = new Set<string>();
    const resolved = options.specs.map((candidate) => {
        const spec = Object.freeze({ ...candidate });
        if (!toolNamePattern.test(spec.toolName)) {
            throw new Error(`Process Tool name "${spec.toolName}" is invalid`);
        }
        if (names.has(spec.toolName)) {
            throw new Error(
                `Process Tool name "${spec.toolName}" is duplicated`,
            );
        }
        names.add(spec.toolName);

        const identityKey = `${spec.process}\u0000${spec.version}`;
        if (identities.has(identityKey)) {
            throw new Error(
                `Process Tool identity "${spec.process}/${spec.version}" is duplicated`,
            );
        }
        identities.add(identityKey);
        if (
            options.owner?.id === spec.process &&
            options.owner?.version === spec.version
        ) {
            throw new Error(
                `Process Tool "${spec.process}/${spec.version}" cannot call itself`,
            );
        }

        const registration = options.registry.find({
            id: spec.process,
            version: spec.version,
        });
        if (!registration) {
            throw new Error(
                `Process Tool "${spec.process}/${spec.version}" is not available`,
            );
        }
        return Object.freeze({
            spec,
            registration,
            descriptor: Object.freeze({
                name: spec.toolName,
                description: spec.description,
                parameters: describeInput(registration),
            }),
        });
    });
    const byName = new Map(resolved.map((tool) => [tool.spec.toolName, tool]));

    return Object.freeze({
        specs: Object.freeze(resolved.map(({ spec }) => spec)),
        descriptors: Object.freeze(
            resolved.map(({ descriptor }) => descriptor),
        ),
        invoke: async (request) => {
            if (
                !Number.isSafeInteger(request.invocation) ||
                request.invocation < 1
            ) {
                throw new Error("Process Tool invocation must be positive");
            }
            const tool = byName.get(request.toolName);
            if (!tool) {
                throw new Error(
                    `Process Tool "${request.toolName}" is not available`,
                );
            }
            return runProcessTool({
                ...request,
                spec: tool.spec,
                registration: tool.registration,
                attemptRunner: options.attemptRunner,
            });
        },
    });
}

export function processToolRunId(
    parentRunId: string,
    invocation: number,
): string {
    if (!Number.isSafeInteger(invocation) || invocation < 1) {
        throw new Error("Process Tool invocation must be positive");
    }
    return `${parentRunId}.${invocation}`;
}

type ResolvedInvocation = ProcessToolInvocationRequest &
    Readonly<{
        spec: ProcessToolSpec;
        registration: ProcessRegistration;
        attemptRunner: ProcessAttemptRunner;
    }>;

async function runProcessTool(
    request: ResolvedInvocation,
): Promise<ProcessToolInvocation> {
    const base = {
        invocation: request.invocation,
        process: request.spec.process,
        version: request.spec.version,
        sideEffect: request.spec.sideEffect,
    } as const;

    let acceptance: ReturnType<ProcessRegistration["accept"]>;
    try {
        acceptance = request.registration.accept(request.input);
    } catch {
        return failedInvocation(
            base,
            "INTERNAL_ERROR",
            "The Process Tool could not be completed",
        );
    }
    if (!acceptance.accepted) {
        return failedInvocation(
            base,
            "INVALID_INPUT",
            "The Process Tool input is invalid",
        );
    }

    const runId = processToolRunId(request.parentRunId, request.invocation);
    for (
        let attemptNumber = 1;
        attemptNumber <= request.registration.retryPolicy.maximumAttempts;
        attemptNumber += 1
    ) {
        const result = await request.attemptRunner.run({
            runId,
            registration: request.registration,
            acceptedInput: acceptance.acceptedInput,
            attemptNumber,
            signal: request.signal,
        });
        if (result.status === "succeeded") {
            return Object.freeze({
                ...base,
                status: "succeeded",
                output: result.output as JsonValue,
            });
        }
        if (
            attemptNumber >= request.registration.retryPolicy.maximumAttempts ||
            !request.registration.retryPolicy.retryableErrorCodes.some(
                (code) => code === result.error.code,
            ) ||
            request.signal.aborted
        ) {
            return failedInvocation(
                base,
                result.error.code,
                result.error.message,
            );
        }
        await waitForRetry(
            retryDelay(request.registration.retryPolicy, attemptNumber),
            request.signal,
        );
    }
    return failedInvocation(
        base,
        "INTERNAL_ERROR",
        "The Process Tool could not be completed",
    );
}

function retryDelay(
    policy: ProcessRegistration["retryPolicy"],
    attemptNumber: number,
): number {
    return Math.min(
        policy.backoff.initialDelayMs * 2 ** (attemptNumber - 1),
        policy.backoff.maximumDelayMs,
    );
}

async function waitForRetry(
    delayMs: number,
    signal: AbortSignal,
): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
        const timeout = setTimeout(done, delayMs);
        const cancel = () => done();
        signal.addEventListener("abort", cancel, { once: true });
        function done() {
            clearTimeout(timeout);
            signal.removeEventListener("abort", cancel);
            resolve();
        }
    });
}

function failedInvocation(
    base: Readonly<{
        invocation: number;
        process: string;
        version: string;
        sideEffect: ProcessToolSideEffect;
    }>,
    code: ProcessErrorCode,
    message: string,
): ProcessToolInvocation {
    return Object.freeze({
        ...base,
        status: "failed",
        error: Object.freeze({ code, message }),
    });
}

function describeInput(
    registration: ProcessRegistration,
): Readonly<Record<string, unknown>> {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(
        registration.inputSchema,
        { io: "input" },
    );
    return Object.freeze(schema);
}
