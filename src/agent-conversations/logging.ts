/** 输出仅含稳定 identity、状态、计数、耗时与净化错误的 Agent Activity */
import type { AgentToolActivity } from "./tools.postgres.js";
import type { AgentTurnActivity } from "./worker.js";

export function writeAgentActivity(
    activity: AgentToolActivity | AgentTurnActivity,
): void {
    console.log(
        JSON.stringify({
            service: "pi-business-processing-service",
            module: "agent-conversations",
            ...activity,
        }),
    );
}
