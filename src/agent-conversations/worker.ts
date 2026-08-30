/** 从最小 Agent Turn Job 认领首轮 Turn，执行准确 Registration 并提交公共终态 */

import { type AgentTurnSource, parseAgentTurnJob } from "./queue.js";
import type { AgentRegistry } from "./registry.js";
import type { AgentConversationStore } from "./store.js";

export type AgentTurnWorker = Readonly<{
    process: (job: unknown) => Promise<"processed" | "ignored" | "invalid-job">;
}>;

export function createAgentTurnWorker(options: {
    registry: AgentRegistry;
    store: AgentConversationStore;
    clock?: () => string;
}): AgentTurnWorker {
    const clock = options.clock ?? (() => new Date().toISOString());
    return Object.freeze({
        process: async (rawJob) => {
            const job = parseAgentTurnJob(rawJob);
            if (!job) return "invalid-job";
            const started = await options.store.start({
                turnId: job.turnId,
                startedAt: clock(),
            });
            if (!started) return "ignored";

            const registration = options.registry.find(started.agent);
            const completion =
                registration?.revision === started.configRevision
                    ? await registration.run({
                          conversationId: started.conversationId,
                          turnId: started.turnId,
                          input: started.input,
                          signal: new AbortController().signal,
                      })
                    : {
                          status: "failed" as const,
                          error: {
                              code: "INTERNAL_ERROR" as const,
                              message: "The Agent Turn could not be completed",
                          },
                      };
            const completed = await options.store.complete({
                turnId: started.turnId,
                completedAt: clock(),
                completion,
            });
            return completed ? "processed" : "ignored";
        },
    });
}

export type AgentTurnDrain = Readonly<{
    drainOne: () => Promise<"processed" | "ignored" | "invalid-job" | "empty">;
}>;

export function createAgentTurnDrain(options: {
    source: AgentTurnSource;
    worker: AgentTurnWorker;
}): AgentTurnDrain {
    return Object.freeze({
        drainOne: async () => {
            const job = await options.source.take();
            return job ? options.worker.process(job) : "empty";
        },
    });
}
