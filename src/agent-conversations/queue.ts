/** 定义最小 Agent Turn Job Interface，并提供可确定性 drain 的内存 Queue Adapter */
export type AgentTurnJob = Readonly<{
    schemaVersion: 1;
    turnId: string;
}>;

export type AgentTurnQueue = Readonly<{
    enqueue: (job: AgentTurnJob) => Promise<"enqueued" | "duplicate">;
    close: () => Promise<void>;
}>;

export type AgentTurnSource = Readonly<{
    take: () => Promise<AgentTurnJob | undefined>;
}>;

export type InMemoryAgentTurnQueue = AgentTurnQueue & AgentTurnSource;

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
