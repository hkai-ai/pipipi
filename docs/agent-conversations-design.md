# Agent Conversations 设计

本文面向实现和维护 Interactive Agent 的开发者，记录 Agent Conversations Module 的当前 Interface、边界和分阶段状态。产品调用契约统一维护在 [`api.md`](api.md#agent-conversations多轮文本)；Business Process 与 Process Run 语义仍以 [`process-runtime-design.md`](process-runtime-design.md) 和 [`async-process-runs-design.md`](async-process-runs-design.md) 为准。

## 当前结论

Agent Conversations 与 Business Process 并列，不覆盖 Process 内部请求级 Agent。Conversation 可以依赖 Process Runtime；Process Registration、Process Run 和 `/execute` 不能反向依赖 Conversation。

当前实现支持可靠多轮文本：准确 Agent Registration、严格 Content Block、创建和增量追加、owner-scoped cursor pagination、操作级幂等、单活跃 Turn、无分支 sequence、受预算 Context Assembly、可重建 Working Summary、内存 Store、确定性 Queue 和脚本化 Worker。production Composition Root 尚未装配，所以默认服务不挂载路由。图片、PostgreSQL、BullMQ、Process Tool Ledger、删除和 production `design-assistant/v1` 仍是后续阶段。

## 共同语言

- **Agent Conversation**：一个 owner-scoped、固定到准确 Agent Registration 的交互聚合。当前内存 Adapter 只证明 Interface，尚不提供生产持久性。
- **Agent Turn**：Conversation 中按 sequence 排序的一次用户增量输入与 Agent 终态输出。同一 Conversation 最多有一个 queued/running Turn。
- **Agent Registration**：准确 Agent id/version 的代码定义，绑定 revision、输入输出接受、Turn/Context/分页上限与 Interactive Agent。
- **Session History**：所有 accepted Turn 的权威公共记录。失败 Turn 保留状态，但没有输出可进入后续 Context。
- **Working Summary**：从较旧 succeeded Turn 的公共输入输出重建的派生文本；它不覆盖、不改写 Session History。
- **Conversation Context**：当前输入之外，由 Working Summary 和有限个最近 succeeded Turn 组成的公开上下文。固定指令和 Runtime Skill 仍封装在 Registration 所拥有的 Agent 实现中。
- **Pi Session**：每次 Turn 执行时创建并释放的请求级模型对象，不是 Conversation，也不是 Memory 权威来源。

## Module 与 Interface

| Module | Interface | 隐藏的 Implementation |
| --- | --- | --- |
| Agent Conversations | `open`、`continue`、`find` | strict envelope、准确 Registration、caller、操作 fingerprint、identity 分配、分页游标、Queue 唤醒和公共投影 |
| Agent Registration | `identity`、`revision`、`limits`、`accept`、`run` | Content Block Schema、全局上限收紧、accepted input、Interactive Agent、输出校验和稳定失败 |
| Agent Registry | `find(identity)`、`list()` | nominal Registration 校验、重复 identity 拒绝、准确版本 Map |
| Agent Conversation Store | `accept`、`acceptTurn`、`findOwnedMetadata`、`findOwnedPage`、`start`、`complete` | owner、操作级 idempotency index、原子 busy/sequence/capacity 判断与权威 Turn；当前只有内存 Adapter |
| Context Assembly | `assembleAgentConversationContext` | succeeded 公共历史过滤、最近历史窗口、Working Summary 重建和保守 token 上界 |
| Agent Turn Queue | `enqueue(job)`、`take()` | `{ schemaVersion, turnId }` 最小 Job、去重和确定性 drain；当前只有内存 Adapter |
| Agent Turn Worker | `process(job)` | Job 校验、准确 Registration/revision、Context Assembly、running/terminal 转换和错误净化 |
| HTTP Adapter | `POST /agent-conversations`、`POST /agent-conversations/{id}/turns`、`GET /agent-conversations/{id}` | media type、body limit、可信 caller、幂等 header、cursor query、HTTP 状态和 Retry-After |

Agent Conversations 是主业务 Seam。HTTP 测试从完整 Application 进入，并注入脚本化 Interactive Agent、内存 Store 和确定性 Queue；测试不依赖 Prompt 文本、模型 SDK 或私有调用顺序。

## 接受与执行顺序

1. HTTP Adapter 解析可信 caller 与 `Idempotency-Key`，再执行 media type 和请求体大小限制。
2. 创建严格接受 `{ agent, input }`；追加严格接受 `{ afterTurnId, input }`。调用方不能提交运行配置。
3. Registration 准确解析输入，并以自身 limits 收紧全局 Turn、输入、输出、Context 与分页上限。
4. Store 先按 caller + key 比对操作 fingerprint。相同请求返回原 Turn 的当前状态；不同请求返回 `IDEMPOTENCY_CONFLICT`。
5. 新追加请求才依次判断 owner、单活跃 Turn、`afterTurnId` 和 Turn 容量，然后原子分配下一个 sequence。并发标签页不能产生分支或重复 sequence。
6. 只有新建 Turn 才写入最小 Queue Job。HTTP 返回 `202`、Location 和 Retry-After，不等待 Agent。
7. Worker 以 Store 为权威认领 Turn；Context Assembly 只读取先前 succeeded Turn 的公共输入输出，选择有限最近历史，并从更旧历史重建 Working Summary。
8. Registration 调用 Interactive Agent。异常成为 `AGENT_FAILURE`，无效或超限输出成为 `INVALID_OUTPUT`；Store 保存唯一终态。
9. owner 查询通过有上限 cursor page 返回历史。不存在与其他 owner 所有的 Conversation 统一投影为 404。

## Invariant 与限制

- 创建必须同时包含第一轮，不能产生空 Conversation；追加必须声明最后接受的 `afterTurnId`。
- Agent version、revision 和 limits 在创建时固定；Worker 不允许用不同 revision 执行旧 Turn。
- 幂等范围是 caller + key，fingerprint 包含操作类型和规范化业务请求；重放先于 busy、sequence 和 capacity 判断。
- sequence 单调、唯一、无分支；每个 Conversation 同时最多一个 queued/running Turn。
- Context 只含 Working Summary、有限 succeeded 公共历史和当前输入。queued、running、failed 输出、Prompt、隐藏推理、原始 provider 消息、Secret 与内部异常不进入 Context。
- Working Summary 是可从权威 Session History 重建的派生状态。当前实现每次重建，不把 Summary 当作权威记录。
- Token 预算用序列化 UTF-8 byte 长度作为保守上界；Registration 只能收紧全局上限，不能扩大。
- 当前 Store 与 Queue 是本地替换 Adapter，不提供崩溃恢复、claim lease、fencing 或跨进程一致性；production 入口必须保持关闭。
- 当前没有图片、持久 Memory、Tool、删除、过期、SSE 或 Canvas Document。

## 测试面

最高测试 Seam 是业务 HTTP Interface。确定性验收覆盖路由关闭、`/execute` 回归、准确版本、严格输入、创建、追加、双标签页竞争、busy、陈旧前驱、操作级重放/冲突、owner 隔离、游标分页、历史截断、摘要重建、失败历史排除、Registration 上限、Worker 终态和 Agent 异常净化。

后续阶段只有在内存 Application 无法证明数据库事务、Queue 至少一次、claim/fencing 或清理批次时，才增加 PostgreSQL 与 BullMQ 集成 Seam。真实模型和付费图片不进入默认测试。
