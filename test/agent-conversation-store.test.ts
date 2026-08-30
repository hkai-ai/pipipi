/** 验证内存 Agent Conversation Store 遵守持久 Adapter 共用契约 */
import { createInMemoryAgentConversationStore } from "../src/agent-conversations/store.js";
import { agentConversationStoreContract } from "./support/agent-conversation-store-contract.js";

agentConversationStoreContract("In-memory", () =>
    createInMemoryAgentConversationStore(),
);
