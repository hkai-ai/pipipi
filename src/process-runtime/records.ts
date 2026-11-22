/** 定义含调用方归属、上游关联与失败审计明细的 Process Run Record 存取接口，提供禁用与内存 Adapter。 */
import {
    type ProcessRunFailureDetail,
    sanitizeDiagnosticText,
    sanitizeFailureDetail,
} from "./input-validation.js";
import type { ProcessErrorCode, ProcessRunResult } from "./result.js";

export type ProcessRunRecordErrorCode =
    | ProcessErrorCode
    | "IDEMPOTENCY_KEY_REQUIRED"
    | "INVALID_IDEMPOTENCY_KEY";

export type ProcessRunRecord = {
    readonly callerId?: string;
    readonly authMethod?: "api_key" | "gateway" | "anonymous";
    readonly schemaVersion: 1;
    readonly recordedAt: string;
    readonly runId: string;
    readonly process?: string;
    readonly version?: string;
    readonly templateSemanticsVersion?: number;
    readonly sourceRunId?: string;
    readonly status: "succeeded" | "failed";
    readonly errorCode?: ProcessRunRecordErrorCode;
    readonly failureDetail?: ProcessRunFailureDetail;
    readonly content?: {
        readonly input: unknown;
        readonly output?: unknown;
    };
};

export type CompletedProcessRun = {
    readonly callerId?: string;
    readonly authMethod?: "api_key" | "gateway" | "anonymous";
    readonly result:
        | ProcessRunResult
        | Readonly<{
              runId: string;
              process?: string;
              version?: string;
              status: "failed";
              error: Readonly<{
                  code: ProcessRunRecordErrorCode;
                  message: string;
              }>;
          }>;
    readonly sourceRunId?: string;
    readonly failureDetail?: ProcessRunFailureDetail;
    readonly acceptedRequest?: {
        readonly input: unknown;
    };
};

/**
 * Records observable Process Run outcomes. This is not an authoritative user
 * conversation store, and it never receives hidden Agent reasoning.
 */
export type ProcessRunRecords = {
    record: (completion: CompletedProcessRun) => void | Promise<void>;
    find: (runId: string) => Promise<ProcessRunRecord | undefined>;
};

export type ProcessRunRecordAdapter = {
    store: (record: ProcessRunRecord) => void | Promise<void>;
    find: (runId: string) => Promise<ProcessRunRecord | undefined>;
};

export function createProcessRunRecords(options: {
    adapter: ProcessRunRecordAdapter;
    content?: "omit" | "accepted-input-and-output";
    clock?: () => string;
}): ProcessRunRecords {
    const content = options.content ?? "omit";
    const clock = options.clock ?? (() => new Date().toISOString());

    return {
        record: (completion) => {
            try {
                const record = structuredClone(
                    createRecord(completion, content, clock()),
                );
                const storage = options.adapter.store(record);
                return storage?.catch(() => {});
            } catch {
                // Recording is best-effort and cannot change process execution.
            }
        },
        find: async (runId) => {
            const record = await options.adapter.find(runId);
            return record ? structuredClone(record) : undefined;
        },
    };
}

const disabledProcessRunRecordAdapter: ProcessRunRecordAdapter = Object.freeze({
    store: () => {},
    find: async () => undefined,
});

export const disabledProcessRunRecords = createProcessRunRecords({
    adapter: disabledProcessRunRecordAdapter,
});

export function createInMemoryProcessRunRecords(
    options: {
        maxRecords?: number;
        content?: "omit" | "accepted-input-and-output";
        clock?: () => string;
    } = {},
): ProcessRunRecords {
    const { maxRecords, ...recordOptions } = options;
    return createProcessRunRecords({
        adapter: createInMemoryProcessRunRecordAdapter({ maxRecords }),
        ...recordOptions,
    });
}

function createInMemoryProcessRunRecordAdapter(
    options: { maxRecords?: number } = {},
): ProcessRunRecordAdapter {
    const maxRecords = options.maxRecords ?? 100;
    if (!Number.isInteger(maxRecords) || maxRecords < 1) {
        throw new Error(
            "Process Run Record capacity must be a positive integer",
        );
    }

    const records = new Map<string, ProcessRunRecord>();

    return {
        store: (record) => {
            if (!records.has(record.runId) && records.size >= maxRecords) {
                const oldestRunId = records.keys().next().value;
                if (oldestRunId !== undefined) records.delete(oldestRunId);
            }
            records.set(record.runId, record);
        },
        find: async (runId) => records.get(runId),
    };
}

/** 只读取模板解析实际输出中的运行语义版本，也用于展示保有正文的历史记录。 */
export function templateSemanticsVersion(
    process: string | undefined,
    output: unknown,
): number | undefined {
    if (process !== "template-from-image") return undefined;
    const template = objectField(output, "template");
    const version = objectField(
        objectField(template, "runtimeSemantics"),
        "version",
    );
    return typeof version === "number" &&
        Number.isSafeInteger(version) &&
        version > 0
        ? version
        : undefined;
}

function objectField(value: unknown, name: string): unknown {
    return value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)[name]
        : undefined;
}

/** 读取母版生成关联的上游 template-from-image 运行 ID，即使未保留正文也支持控制台溯源。 */
export function sourceRunIdOf(
    process: string | undefined,
    input: unknown,
): string | undefined {
    if (process !== "template-master") return undefined;
    const raw = objectField(input, "sourceRunId");
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > 256) return undefined;
    return sanitizeDiagnosticText(trimmed, 256);
}

function createRecord(
    completion: CompletedProcessRun,
    contentPolicy: "omit" | "accepted-input-and-output",
    recordedAt: string,
): ProcessRunRecord {
    const { result } = completion;
    const semantics =
        result.status === "succeeded"
            ? templateSemanticsVersion(result.process, result.output)
            : undefined;
    const sourceRunId =
        completion.sourceRunId ??
        sourceRunIdOf(result.process, completion.acceptedRequest?.input);
    const failureDetail =
        result.status === "failed"
            ? sanitizeFailureDetail(completion.failureDetail)
            : undefined;
    return {
        schemaVersion: 1,
        recordedAt,
        ...(completion.callerId ? { callerId: completion.callerId } : {}),
        ...(completion.authMethod ? { authMethod: completion.authMethod } : {}),
        runId: result.runId,
        ...(result.process === undefined ? {} : { process: result.process }),
        ...(result.version === undefined ? {} : { version: result.version }),
        status: result.status,
        ...(semantics === undefined
            ? {}
            : { templateSemanticsVersion: semantics }),
        ...(sourceRunId === undefined ? {} : { sourceRunId }),
        ...(result.status === "failed" ? { errorCode: result.error.code } : {}),
        ...(failureDetail === undefined ? {} : { failureDetail }),
        ...(contentPolicy === "accepted-input-and-output" &&
        completion.acceptedRequest
            ? {
                  content: {
                      input: completion.acceptedRequest.input,
                      ...(result.status === "succeeded"
                          ? { output: result.output }
                          : {}),
                  },
              }
            : {}),
    };
}
