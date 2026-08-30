# Agent Conversations 设计

本文面向实现和维护 Interactive Agent 的开发者，记录 Agent Conversations Module 的当前 Interface、边界和分阶段状态。产品调用契约统一维护在 [`api.md`](api.md#agent-conversations多轮文本与图片资源)；Business Process 与 Process Run 语义仍以 [`process-runtime-design.md`](process-runtime-design.md) 和 [`async-process-runs-design.md`](async-process-runs-design.md) 为准。

## 当前结论

Agent Conversations 与 Business Process 并列，不覆盖 Process 内部请求级 Agent。Conversation 可以依赖 Process Runtime；Process Registration、Process Run 和 `/execute` 不能反向依赖 Conversation。

当前实现支持可靠多轮文本、owner-scoped 图片资源和受控 Business Process Tool：准确 Agent Registration、严格 Content Block、稳定图片元数据、读取时临时投影、创建和追加、cursor pagination、操作级幂等、单活跃 Turn、受预算 Context、内存 Store、确定性 Queue、内存 Tool Ledger、脚本化 Worker 和请求级 Pi Interactive Agent。production Composition Root 尚未装配，所以默认服务不挂载路由。PostgreSQL、BullMQ、删除和 production `design-assistant/v1` 仍是后续阶段。

## 共同语言

- **Agent Conversation**：一个 owner-scoped、固定到准确 Agent Registration 的交互聚合。当前内存 Adapter 只证明 Interface，尚不提供生产持久性。
- **Agent Turn**：Conversation 中按 sequence 排序的一次用户增量输入与 Agent 终态输出。同一 Conversation 最多有一个 queued/running Turn。
- **Agent Registration**：准确 Agent id/version 的代码定义，绑定 revision、输入输出接受、Turn/Context/分页上限、Interactive Agent 和准确 Process Tool allow-list。
- **Session History**：所有 accepted Turn 的权威公共记录。失败 Turn 保留状态，但没有输出可进入后续 Context。
- **Working Summary**：从较旧 succeeded Turn 的公共输入输出重建的派生文本；它不覆盖、不改写 Session History。
- **Conversation Context**：当前输入之外，由 Working Summary 和有限个最近 succeeded Turn 组成的公开上下文。固定指令和 Runtime Skill 仍封装在 Registration 所拥有的 Agent 实现中。
- **Agent Image Resource**：owned-service 中的稳定图片 identity 与媒体类型、字节数、宽高。请求只提交 `resourceId`；历史不保存 URL 或图片字节。
- **Resource Projection**：查询时由 Resolver 为 owner 临时签发的 HTTPS URL 与 `expiresAt`，不是权威历史。
- **Agent Tool Ledger**：记录本 Turn 的稳定调用 identity、输入摘要、准确 Process、side effect、终态和净化结果；当前内存 Adapter 只证明串行、重放、冲突和预算语义。
- **Pi Session**：每次 Turn 执行时创建并释放的请求级模型对象，不是 Conversation，也不是 Memory 权威来源。

## Module 与 Interface

| Module | Interface | 隐藏的 Implementation |
| --- | --- | --- |
| Agent Conversations | `open`、`continue`、`find` | strict envelope、准确 Registration、caller、操作 fingerprint、identity 分配、分页游标、Queue 唤醒和公共投影 |
| Agent Registration | `identity`、`revision`、`limits`、`accept`、`run` | Content Block Schema、全局上限收紧、accepted input、Interactive Agent、准确 Process Tool Runtime、输出校验和稳定失败 |
| Agent Registry | `find(identity)`、`list()` | nominal Registration 校验、重复 identity 拒绝、准确版本 Map |
| Agent Conversation Store | `accept`、`acceptTurn`、`findOwnedMetadata`、`findOwnedPage`、`start`、`complete` | owner、操作级 idempotency index、原子 busy/sequence/capacity 判断与权威 Turn；当前只有内存 Adapter |
| Context Assembly | `assembleAgentConversationContext` | succeeded 公共历史过滤、最近历史窗口、Working Summary 重建和保守 token 上界 |
| Agent Resource Resolver | `inspectInput`、`inspectOutput`、`acquire`、`project` | owner/存在性、稳定媒体元数据、模型 base64、获准输出证明和临时读取 URL；生产 Adapter 只调用 owned resource service |
| Agent Tool Ledger | `bind(request)`、`records(turnId)` | 每 Turn 串行调用、稳定 invocation、输入 fingerprint、幂等重放、冲突检测、费用预算和净化记录；当前只有内存 Adapter |
| Pi Interactive Agent | `respond(request)` | 固定 Skill/指令、Registration Tool 白名单、请求级串行 Session、多模态附件、JSON 输出解析，以及成功/失败/取消释放 |
| Agent Turn Queue | `enqueue(job)`、`take()` | `{ schemaVersion, turnId }` 最小 Job、去重和确定性 drain；当前只有内存 Adapter |
| Agent Turn Worker | `process(job)` | Job 校验、准确 Registration/revision、Context Assembly、Tool 绑定、图片获取/释放、输出来源验证、running/terminal 转换和错误净化 |
| HTTP Adapter | `POST /agent-conversations`、`POST /agent-conversations/{id}/turns`、`GET /agent-conversations/{id}` | media type、body limit、可信 caller、幂等 header、cursor query、HTTP 状态和 Retry-After |

Agent Conversations 是主业务 Seam。HTTP 测试从完整 Application 进入，并注入脚本化 Interactive Agent、内存 Store 和确定性 Queue；测试不依赖 Prompt 文本、模型 SDK 或私有调用顺序。

## 接受与执行顺序

1. HTTP Adapter 解析可信 caller 与 `Idempotency-Key`，再执行 media type 和请求体大小限制。
2. 创建严格接受 `{ agent, input }`；追加严格接受 `{ afterTurnId, input }`。调用方不能提交运行配置。
3. Registration 准确解析文本或 `{ type: "image", resourceId }`，并以自身 limits 收紧全局 Turn、输入输出、图片数量/大小/类型/尺寸、Context 与分页上限。
4. Resource Resolver 按 caller 检查每个输入资源，返回稳定元数据；不存在与其他 owner 所有统一成为 `INVALID_INPUT`。HTTP 不接受 URL、base64、文件路径或上传内容。
5. Store 先按 caller + key 比对操作 fingerprint，再原子执行 busy、`afterTurnId` 和容量判断。
6. Worker 认领 Turn，装配 succeeded 公共 Context，再让 Resolver 为其中的稳定图片换取模型内容。
7. Worker 只把 Registration 固定的准确 Process Tool 绑定到本 Turn。每次调用先过 Ledger 预算，再由共享 Process Tool Runtime 执行成员 Registration 的输入校验和 Process Attempt。
8. Tool 按调用 ordinal 串行执行；子 Run identity 固定为 `{turnId}.{ordinal}`。取消信号传入 Process Attempt。
9. Agent 文本输出必须来自本 Turn 成功 Tool 结果；图片输出必须由 Resolver 证明来自获准 Adapter 或本 Turn Tool。虚构输出使 Turn 以 `INVALID_OUTPUT` 失败。
10. Pi Session 只在本次执行窗口持有；所有路径 finally 释放。Store 只保存稳定 resource identity 和媒体元数据；owner 查询时才投影临时 URL。

## Invariant 与限制

- 创建必须同时包含第一轮，不能产生空 Conversation；追加必须声明最后接受的 `afterTurnId`。
- Agent version、revision 和 limits 在创建时固定；Worker 不允许用不同 revision 执行旧 Turn。
- 幂等范围是 caller + key，fingerprint 包含操作类型和规范化业务请求；重放先于 busy、sequence 和 capacity 判断。
- sequence 单调、唯一、无分支；每个 Conversation 同时最多一个 queued/running Turn。
- Context 只含 Working Summary、有限 succeeded 公共历史和当前输入。queued、running、failed 输出、Prompt、隐藏推理、原始 provider 消息、Secret 与内部异常不进入 Context。
- 图片块保持与文本块的请求顺序。权威历史和 Queue Job 不保存 base64、临时 URL、`expiresAt`、文件路径或任意远程地址。
- Resource Resolver 是窄 owned-service Adapter，不下载调用方 URL、不读取本地文件，也不提供图片上传入口；模型访问内容只能由 Resolver 返回。
- 调用方不能提交 Tool、Process、预算或运行配置。Registration 在启动期从服务端 Registry 解析准确 Process identity；缺失版本直接阻止 Registration 构造。
- 每 Turn 最多调用 6 次 Tool，其中最多 1 次 priced Tool；每 Conversation 最多成功或失败地尝试 10 次 priced Tool。Registration 只能收紧这些上限。
- Ledger 用 `{turnId}.{ordinal}` 识别调用。同 identity 和输入 fingerprint 重放原结果；同 identity 改变输入返回冲突。v1 在同一 Turn 内串行调用。
- 每个 Tool 调用仍经过成员 Registration 的 `accept` 和 Process Attempt Runner；错误以公共 Process Error 净化，取消向下传播。
- 输出图片必须匹配 owner、本 Turn 与获准来源。模型虚构的 URL 或 resource identity 不能成为公共输出。
- Working Summary 是可从权威 Session History 重建的派生状态。当前实现每次重建，不把 Summary 当作权威记录。
- Token 预算用序列化 UTF-8 byte 长度作为保守上界；Registration 只能收紧全局上限，不能扩大。
- 当前 Store 与 Queue 是本地替换 Adapter，不提供崩溃恢复、claim lease、fencing 或跨进程一致性；production 入口必须保持关闭。
- 当前没有图片上传、持久 Memory、删除、过期、SSE 或 Canvas Document；Tool Ledger 尚未持久化，临时读取 URL 的实际签发服务仍由部署方提供。

## 测试面

最高测试 Seam 是业务 HTTP Interface。确定性验收覆盖文本/图片混排、资源 owner 不可枚举、URL/base64/path 拒绝、图片限制、模型访问释放、准确 Tool allow-list、稳定子 Run、串行预算、Conversation 费用上限、Ledger 重放冲突、取消传播、获准输出与虚构输出拒绝。Pi Adapter 另在 Session Seam 验证成功、失败和取消释放。

后续阶段只有在内存 Application 无法证明数据库事务、Queue 至少一次、claim/fencing 或清理批次时，才增加 PostgreSQL 与 BullMQ 集成 Seam。真实模型和付费图片不进入默认测试。
