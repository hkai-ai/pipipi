/** 校验 PostgreSQL 活动 Conversation 引用的 Agent Registration revision 均随当前发布保留 */
import type { Pool } from "pg";
import type { AgentRegistry } from "../agent-conversations/registry.js";

export async function assertAgentRegistrationRevisions(options: {
    pool: Pool;
    registry: AgentRegistry;
}): Promise<void> {
    const result = await options.pool.query<{
        agent_id: string;
        agent_version: string;
        config_revision: string;
    }>(`
      SELECT DISTINCT agent_id, agent_version, config_revision
      FROM agent_conversations
      WHERE status IN ('busy', 'ready') AND expires_at > now()
    `);
    for (const row of result.rows) {
        if (
            !options.registry.findRevision(
                { id: row.agent_id, version: row.agent_version },
                row.config_revision,
            )
        ) {
            throw new Error(
                "An active Agent Conversation requires an unavailable Registration revision",
            );
        }
    }
}
