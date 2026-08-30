/** 定义最小 Agent Turn Job Interface，并提供可确定性 drain 的内存 Queue Adapter */
export type AgentTurnJob = Readonly<{
    schemaVersion: 1;
    turnId: string;
}>;

export type AgentTurnQueue = Readonly<{
    enqueue: (job: AgentTurnJob) => Promise<"enqueued" | "duplicate">;
    close: () => Promise<void>;
}>;

export type AgentTurnJobInspection = Readonly<{
    turnId: string;
    state: "runnable" | "terminal" | "invalid" | "missing";
}>;

export type RecoverableAgentTurnQueue = AgentTurnQueue &
    Readonly<{
        inspectJobs: (
            turnIds: readonly string[],
        ) => Promise<readonly AgentTurnJobInspection[]>;
    }>;

export type AgentTurnSource = Readonly<{
    take: () => Promise<AgentTurnJob | undefined>;
}>;

export type InMemoryAgentTurnQueue = RecoverableAgentTurnQueue &
    AgentTurnSource;

export function createInMemoryAgentTurnQueue(): InMemoryAgentTurnQueue {
    const jobs: AgentTurnJob[] = [];
    const turnIds = new Set<string>();
    let closed = false;

    return Object.freeze({
        enqueue: async (job) => {
            assertAgentTurnJob(job);
            if (closed) throw new Error("Agent Turn Queue is closed");
            if (turnIds.has(job.turnId)) return "duplicate";
            const snapshot = structuredClone(job);
            jobs.push(snapshot);
            turnIds.add(snapshot.turnId);
            return "enqueued";
        },
        take: async () => {
            const job = jobs.shift();
            if (!job) return undefined;
            turnIds.delete(job.turnId);
            return structuredClone(job);
        },
        inspectJobs: async (requestedTurnIds) => {
            assertInspectionTurnIds(requestedTurnIds);
            return requestedTurnIds.map((turnId) =>
                Object.freeze({
                    turnId,
                    state: turnIds.has(turnId) ? "runnable" : "missing",
                }),
            );
        },
        close: async () => {
            closed = true;
        },
    });
}

export function parseAgentTurnJob(value: unknown): AgentTurnJob | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const candidate = value as Record<string, unknown>;
    if (
        Object.keys(candidate).length !== 2 ||
        candidate.schemaVersion !== 1 ||
        typeof candidate.turnId !== "string" ||
        candidate.turnId.trim().length === 0 ||
        Buffer.byteLength(candidate.turnId, "utf8") > 256
    ) {
        return undefined;
    }
    return Object.freeze({ schemaVersion: 1, turnId: candidate.turnId });
}

function assertAgentTurnJob(job: AgentTurnJob): void {
    if (!parseAgentTurnJob(job)) throw new Error("Agent Turn Job is invalid");
}

export function assertInspectionTurnIds(turnIds: readonly string[]): void {
    if (turnIds.length < 1 || turnIds.length > 100) {
        throw new Error(
            "Agent Turn Queue inspection requires 1 to 100 Turn IDs",
        );
    }
    const unique = new Set(turnIds);
    if (
        unique.size !== turnIds.length ||
        turnIds.some(
            (turnId) =>
                typeof turnId !== "string" ||
                turnId.trim().length === 0 ||
                Buffer.byteLength(turnId, "utf8") > 256,
        )
    ) {
        throw new Error("Agent Turn Queue inspection Turn IDs are invalid");
    }
}
