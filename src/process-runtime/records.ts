import type { ProcessErrorCode, ProcessRunResult } from "./result.js";

export type ProcessRunRecord = {
    readonly schemaVersion: 1;
    readonly recordedAt: string;
    readonly runId: string;
    readonly process?: string;
    readonly version?: string;
    readonly status: "succeeded" | "failed";
    readonly errorCode?: ProcessErrorCode;
    readonly content?: {
        readonly input: unknown;
        readonly output?: unknown;
    };
};

export type CompletedProcessRun = {
    readonly result: ProcessRunResult;
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

function createRecord(
    completion: CompletedProcessRun,
    contentPolicy: "omit" | "accepted-input-and-output",
    recordedAt: string,
): ProcessRunRecord {
    const { result } = completion;
    return {
        schemaVersion: 1,
        recordedAt,
        runId: result.runId,
        ...(result.process === undefined ? {} : { process: result.process }),
        ...(result.version === undefined ? {} : { version: result.version }),
        status: result.status,
        ...(result.status === "failed" ? { errorCode: result.error.code } : {}),
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
