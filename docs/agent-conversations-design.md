# Agent Conversations 设计

本文面向实现和维护 Interactive Agent 的开发者，记录 Agent Conversations Module 的当前 Interface、边界和分阶段状态。产品调用契约统一维护在 [`api.md`](api.md#agent-conversations首轮文本-tracer-bullet)；Business Process 与 Process Run 语义仍以 [`process-runtime-design.md`](process-runtime-design.md) 和 [`async-process-runs-design.md`](async-process-runs-design.md) 为准。

## 当前结论

Agent Conversations 与 Business Process 并列，不覆盖 Process 内部请求级 Agent。Conversation 可以依赖 Process Runtime；Process Registration、Process Run 和 `/execute` 不能反向依赖 Conversation。

当前实现只完成首轮文本 tracer bullet：准确 Agent Registration、严格文本 Content Block、创建与查询 HTTP Interface、caller ownership、创建幂等、内存 Store、确定性 Queue 和脚本化 Worker。production Composition Root 尚未装配，所以默认服务不挂载路由。多轮、图片、PostgreSQL、BullMQ、Process Tool Ledger、删除和 production `design-assistant/v1` 仍是明确的后续阶段，不能在当前文档中当作已实现能力。

## 共同语言

- **Agent Conversation**：一个 owner-scoped、固定到准确 Agent Registration 的持久交互聚合。当前内存 Adapter 只证明 Interface，尚不提供生产持久性。
- **Agent Turn**：Conversation 中按 sequence 排序的一次用户输入与 Agent 终态输出。当前只存在 sequence 1。
- **Agent Registration**：准确 Agent id/version 的代码定义，绑定 revision、输入接受、Interactive Agent 与输出校验。
- **Agent Registry**：不可变的准确 Registration catalog，只做 id/version 查找，不提供默认或回退。
- **Session History**：完成 Turn 的公共输入输出。当前只保存第一轮；后续多轮阶段才加入 Context Assembly 和 Working Summary。
- **Pi Session**：每次 Turn 执行时创建并释放的请求级模型对象，不是 Conversation，也不是 Memory 权威来源。

## Module 与 Interface

| Module | Interface | 隐藏的 Implementation |
| --- | --- | --- |
| Agent Conversations | `open(request, context)`、`find(conversationId, context)` | strict envelope、准确 Registration、caller、幂等 fingerprint、identity 分配、Queue 唤醒和公共投影 |
| Agent Registration | `identity`、`revision`、`accept(input)`、`run(request)` | 文本 Content Block Schema、accepted input 快照、Interactive Agent 调用、输出 Schema 和稳定失败 |
| Agent Registry | `find(identity)`、`list()` | nominal Registration 校验、重复 identity 拒绝、准确版本 Map |
| Agent Conversation Store | `accept`、`findOwned`、`start`、`complete` | Conversation/Turn 状态、owner 与 idempotency index；当前只有内存 Adapter |
| Agent Turn Queue | `enqueue(job)`、`take()` | `{ schemaVersion, turnId }` 最小 Job、去重和确定性 drain；当前只有内存 Adapter |
| Agent Turn Worker | `process(job)` | Job 校验、准确 Registration/revision、Turn running/terminal 转换和错误净化 |
| HTTP Adapter | `POST /agent-conversations`、`GET /agent-conversations/{conversationId}` | media type、body limit、可信 caller、幂等 header、HTTP 状态和 Retry-After |

Agent Conversations 是主业务 Seam。HTTP 测试从完整 Application 进入，并注入脚本化 Interactive Agent、内存 Store 和确定性 Queue；测试不依赖 Prompt 文本、模型 SDK 或私有方法调用顺序。

## 当前执行顺序

1. HTTP Adapter 先解析可信 caller 与 `Idempotency-Key`，再执行 media type 和请求体大小限制。
2. Agent Conversations 严格解析 `{ agent: { id, version }, input }`，拒绝任何额外运行配置。
3. Agent Registry 准确查找 Registration；Registration 只接受 1–16 个文本 Content Block，并产生不可变 accepted input。
4. Store 按 caller 与 idempotency key 原子接受 Conversation 和 sequence 1 Turn。相同 fingerprint 重放原资源，不同 fingerprint 返回冲突。
5. 只有新建 Turn 才向 Queue 写入 `{ schemaVersion: 1, turnId }`。HTTP 返回 `202`、Location 和 Retry-After，不等待 Agent。
6. 确定性 Worker 取出 Job，把 Turn 从 queued 转为 running，按 Conversation 保存的 Agent identity 与 revision 精确解析 Registration。
7. Registration 调用 Interactive Agent，再把响应校验为文本 Content Block。异常成为 `AGENT_FAILURE`，无效输出成为 `INVALID_OUTPUT`。
8. Store 保存 succeeded/failed 终态。owner 查询把任意非 owner identity 与不存在统一投影为 404。

## Invariant 与限制

- 创建必须同时包含第一轮，不能产生空 Conversation。
- Agent version 和 revision 在创建时固定；Worker 不允许用同 id/version 的不同 revision 执行旧 Turn。
- 幂等范围是 caller + 创建操作 + key。重放只返回原 Conversation，不产生第二个 Queue Job。
- 请求不能包含 role、system Prompt、Skill、Tool、model、provider、Memory、预算、重试或远程地址。
- 公共历史只包含 accepted 用户输入和通过 Schema 的 Agent 输出；Prompt、隐藏推理、原始 provider 消息、Secret 与内部异常不保存也不返回。
- 当前 Store 与 Queue 是本地替换 Adapter，不提供崩溃恢复、claim lease、fencing、容量或跨进程一致性；production 入口必须保持关闭。
- 当前没有追加 Turn、图片、分页、Working Summary、Tool、删除、过期、SSE 或 Canvas Document。

## 测试面

最高测试 Seam 是业务 HTTP Interface。确定性验收覆盖路由关闭、`/execute` 回归、准确版本、严格输入、创建、queued 查询、Worker 完成、文本输出、caller 隔离、幂等重放/冲突以及 Agent 异常净化。

后续阶段只有在内存 Application 无法证明数据库事务、Queue 至少一次、并发约束、claim/fencing 或清理批次时，才增加 PostgreSQL 与 BullMQ 集成 Seam。真实模型和付费图片不进入默认测试。
