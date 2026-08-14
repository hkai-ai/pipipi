# 异步 Process Run 设计

状态：已实现；默认关闭，按发布与运维手册分阶段启用。

本文面向维护异步执行、任务查询和 Webhook 的开发者。它定义当前 Interface、Module 边界和可靠性约束；完成的实施批次见 [`async-process-runs-development-plan.md`](async-process-runs-development-plan.md)，部署与故障处理见 [`async-process-runs-runbook.md`](async-process-runs-runbook.md)。精确行为仍以代码和测试为准。BullMQ、Redis 与 Webhook 的外部事实见 [`research/async-process-execution.md`](research/async-process-execution.md)。

## 结论

异步能力作为独立的 **Async Process Runs Module** 存在，不把 BullMQ 直接暴露给产品调用方：

- 外部服务通过 HTTP 提交和查询：`POST /process-runs` 返回 `202 Accepted`，`GET /process-runs/{runId}` 返回权威状态与结果。
- PostgreSQL 保存可查询的 Process Run、幂等键、Attempt 和事件；它是产品状态的唯一事实来源。
- BullMQ 与 Redis 只调度内部 Queue Job。API 不返回 BullMQ Job ID，也不从 BullMQ 查询产品状态。
- 提交事务同时写入 Process Run 和 outbox。Dispatcher 随后把 `runId` 放入 BullMQ，避免 PostgreSQL 与 Redis 双写造成已接受任务丢失。
- Webhook 是有签名、可重试、至少一次的状态通知。调用方必须按 event ID 去重，并在需要权威结果时查询 Process Run。
- 运维控制台通过独立的 Console Process Run Client Interface 调用 HTTP；页面不解析原始响应，也不拥有轮询或结果地址安全规则。
- 现有 `POST /execute` 保持同步契约。两种入口复用同一个 Process Registration 和执行核心，但使用不同的生命周期治理。

这套边界允许以后替换 Queue Adapter 或 Webhook Delivery Implementation，而不改变外部调用协议。

## 实现基线

仓库保留同步入口，并已经实现独立的异步交付链：

| 当前事实 | 设计约束 |
| --- | --- |
| `POST /execute` 仍等待 `ProcessExecutor.execute` 返回终态 | 同步契约保持兼容，不借用异步状态机 |
| `POST /process-runs` 在 PostgreSQL durable acceptance 后返回 `202` | 接受路径不等待 Redis，查询始终读取 PostgreSQL |
| Process Registration 提供 `accept` 与 `run` 两个原子动作 | 输入只在接受时解释一次；Worker 执行准确版本的 accepted input |
| Run Record 仍是 best-effort 终态观测 | 它不替代异步 Process Run 的权威状态库 |
| API、Dispatcher、Process Worker、Webhook Worker 与 Retention Cleaner 独立启动和关闭 | 每个角色可以单独扩容、停机和验证 readiness |
| PostgreSQL migration、Redis 与 BullMQ Adapter 已接入 | 真实依赖行为由 PostgreSQL 和 BullMQ 集成测试覆盖，发布仍默认关闭 |
| Console Process Run Client 返回结构化进度和终态 | 浏览器先校验 JSON、公共状态、Run identity 与同源 `Location`，结果过期、查询超时与协议错误不进入页面未知异常分支 |
| 一次控制台提交操作拥有可恢复幂等身份 | 首次 POST 前在 tab-scoped session storage 持久化请求摘要、幂等键和恢复分类；响应丢失、可重试 admission 与刷新恢复复用同一 key；accepted 映射必须先明确移除，才能开始新提交 |
| accepted Run 在 300 秒客户端期限内弹性查询 | `Retry-After` 限制在 1–30 秒；缺失或无效时使用 1–30 秒指数退避；瞬时 GET transport 与可重试 HTTP 错误不会丢失恢复映射，超时、Abort 或页面离开都不取消服务端 Run |

`ProcessRunRecords` 不应直接改成权威存储。它的 best-effort invariant 与异步执行要求冲突：异步提交只有在 durable transaction 成功后才能返回 `202`，终态写入失败也不能被静默忽略。

## 共同语言与边界

| 术语 | 定义 | 是否属于公开契约 |
| --- | --- | --- |
| Process Run | 一个已被服务接受、可按 `runId` 查询的 Business Process 执行实例 | 是 |
| Process Attempt | Worker 对同一个 Process Run 的一次受租约保护的执行尝试 | 否；只用于运维与审计 |
| Queue Job | BullMQ 中用于唤醒 Worker 的内部调度消息，payload 只含 envelope schema version 与 `runId` | 否 |
| Process Event | Process Run 状态变化后，在同一数据库事务中写入的不可变事件 | Webhook payload 可公开稳定投影 |
| Webhook Endpoint | 经过调用方授权和服务端校验的通知目标 | 管理面概念，不进入 Process Definition |
| Webhook Delivery | 一个 Process Event 向一个 Webhook Endpoint 的投递记录；可有多次 Delivery Attempt | 查询和重放能力可后续开放 |
| Run Record | 从完成结果派生的观测记录，不参与状态转换或恢复 | 否 |

产品文档和 API 使用 Process Run，不使用 Task 或 BullMQ Job 表示业务执行。Task 可以继续作为口语，但不能成为第二套领域模型。

## 外部调用 Interface

### 调用顺序

```mermaid
sequenceDiagram
    participant Caller as External caller
    participant API as Processing API
    participant DB as PostgreSQL
    participant Dispatcher as Outbox Dispatcher
    participant Queue as BullMQ / Redis
    participant Worker as Process Worker
    participant Delivery as Webhook Delivery Worker
    participant Hook as Webhook Endpoint

    Caller->>API: POST /process-runs + Idempotency-Key
    API->>DB: transaction: Process Run + enqueue event
    DB-->>API: committed
    API-->>Caller: 202 + runId + Location
    Dispatcher->>DB: claim unpublished event
    Dispatcher->>Queue: enqueue { runId }
    Queue->>Worker: at-least-once Job delivery
    Worker->>DB: claim Attempt and load accepted input
    Worker->>Worker: execute exact Process Registration
    Worker->>DB: transaction: terminal state + Process Event
    Caller->>API: GET /process-runs/{runId}
    API->>DB: read caller-owned Process Run
    API-->>Caller: current state or terminal result
    Delivery->>DB: load terminal event and endpoint
    Delivery->>Hook: signed terminal Webhook
    Hook-->>Delivery: 2xx acknowledgement
```

调用方不连接 Redis，也不需要 BullMQ SDK。队列不可用时，已提交的 outbox 事件保留在 PostgreSQL；Dispatcher 恢复后继续入队。

### 提交 Process Run

```http
POST /process-runs HTTP/1.1
Content-Type: application/json
Idempotency-Key: 7d5401ac-e47b-40c7-8803-2be4ccf7df80

{
  "process": "content-processing",
  "version": "v1",
  "input": {
    "content": "launch offer"
  }
}
```

服务端按现有规则严格校验 envelope、精确 Process 版本和业务输入。只有被 Process Registration 接受的输入才会进入持久化事务。无效请求和不存在的 Process 不创建 Process Run。

成功响应：

```http
HTTP/1.1 202 Accepted
Location: /process-runs/019c...
Retry-After: 2
Content-Type: application/json

{
  "runId": "019c...",
  "process": "content-processing",
  "version": "v1",
  "status": "queued",
  "createdAt": "2026-08-09T10:00:00.000Z"
}
```

提交 Interface 保持以下 invariant：

- `Idempotency-Key` 对异步提交必填，并按已认证调用方隔离。调用方超时或断线后必须用同一个 key 重试。
- 同一个调用方、同一个 key 和同一个规范化请求重放原始接受响应并返回同一个 `runId`；同一个 key 配合不同请求返回 `409 IDEMPOTENCY_CONFLICT`。
- API 只在 Process Run 与 outbox 已经提交后返回 `202`。返回 `202` 后，即使 Redis 暂时不可用，服务也必须最终调度或明确标记失败。
- 数据库不可用或 durable backlog 已超过准入上限时，API 在接受前返回 `503` 或 `429`，并带 `Retry-After`；此时不返回 `runId`。
- 调用方不能提交重试次数、Queue Job 选项、模型、Skill、Tool、Webhook URL 或其他运行配置。

### 查询 Process Run

```http
GET /process-runs/019c... HTTP/1.1
Authorization: Bearer replace-with-short-lived-token
```

非终态响应：

```json
{
  "runId": "019c...",
  "process": "content-processing",
  "version": "v1",
  "status": "running",
  "createdAt": "2026-08-09T10:00:00.000Z",
  "startedAt": "2026-08-09T10:00:01.000Z"
}
```

终态成功响应在调用方有内容访问权且结果仍在保留期内时增加 `output`；终态失败响应增加现有稳定的公开 `error`。结果内容到期后仍返回终态、开始与完成时间，并以 `resultAvailability: "expired"` 和 `resultExpiredAt` 明确表达内容不可用；它不返回 `output: null` 或虚构错误。响应不包含 Attempt 栈、BullMQ 状态、Prompt、Tool 过程、模型消息、内部错误或 Webhook secret。

初始公开状态只包含：

```text
queued -> running -> succeeded
   ^          |
   |          +----> failed
   +----------+      retryable Attempt
```

`queued` 同时表示等待第一次执行和等待下一次受控重试。Attempt 次数、backoff 和 Worker 信息留在 Implementation。初始版本不提供取消；以后增加取消时必须先定义副作用补偿和竞态语义。

调研中也评估了公开 `retrying`。本设计把它折叠进 `queued`，避免调用方依赖内部 attempts 和 backoff；如果产品以后确实要向用户解释等待原因，再通过兼容字段扩展，而不直接映射 BullMQ 状态。

查询 Interface 保持以下 invariant：

- API 从 PostgreSQL 读取，不从 BullMQ 推断状态。
- 调用方只能读取自己拥有的 Process Run。未知和无权访问的 `runId` 都返回 `404`，避免枚举资源。
- 非终态响应可以带 `Retry-After`，并设置 `Cache-Control: no-store`。
- Webhook 丢失、重复或延迟不影响查询结果。
- 首个版本只要求按 `runId` 查询；列表、筛选、Attempt 明细和管理面搜索后续另行设计。

### Webhook

首个 Webhook 版本只发送终态事件：`process_run.succeeded` 和 `process_run.failed`。Webhook Endpoint 应预先注册并绑定到调用方；提交请求只能选择调用方已有的 endpoint ID，或使用该调用方的默认 endpoint，不能携带任意 URL。

```json
{
  "id": "evt_019c...",
  "type": "process_run.succeeded",
  "createdAt": "2026-08-09T10:00:08.000Z",
  "data": {
    "runId": "019c...",
    "process": "content-processing",
    "version": "v1",
    "status": "succeeded"
  }
}
```

Webhook 不携带业务输入、输出或内部错误。接收方验证签名后，用自己的 API 凭证查询结果。Delivery Interface 保持以下 invariant：

- 按 Standard Webhooks 的 `webhook-id`、`webhook-timestamp` 和 `webhook-signature` 头签名原始请求体，并支持 secret 轮换。
- 同一个 Process Event 可以投递多次；重试使用同一个 event ID。接收方必须按 event ID 幂等处理，并校验时间戳以限制重放。
- 只把 `2xx` 视为成功。`410` 停用 endpoint；网络错误、超时和其他非 `2xx` 在总投递期限内使用指数 backoff 与 jitter，`429`、`502`、`503`、`504` 还应尊重有效的 `Retry-After`。`3xx` 不跟随，重试耗尽后进入失败状态，供管理面检查或重放。
- 每次 Delivery Attempt 持久化时间、结果分类、下次重试时间和有限的 HTTP 元数据，不保存远端完整响应正文。
- Endpoint 校验和实际发送都禁止私网、loopback、link-local、云 metadata 地址、非 HTTPS 和不受控重定向；部署层同时限制 egress，降低 SSRF 风险。
- 事件至少一次投递，不承诺跨 Process Run 的全局顺序。调用方以查询到的当前 Process Run 状态为准。

## Module 设计

```mermaid
flowchart LR
    Caller["External caller"] --> HTTP["HTTP Adapter"]
    HTTP --> Async["Async Process Runs<br/>submit / find"]
    Async --> Registry["Process Registry"]
    Async --> Store["Process Run Store"]
    Store --> PG["PostgreSQL Adapter"]
    Dispatch["Outbox Dispatcher"] --> Store
    Dispatch --> WorkQueue["Process Work Queue"]
    WorkQueue --> Bull["BullMQ Adapter"]
    Bull --> Worker["Process Worker"]
    Worker --> Attempts["Process Attempt Runner"]
    Attempts --> Registry
    Attempts --> Store
    Store --> Events["Process Events"]
    Events --> Delivery["Webhook Delivery"]
    Delivery --> HookQueue["Webhook Queue"]
    HookQueue --> Endpoint["Registered Webhook Endpoint"]
    Cleaner["Retention Cleaner"] --> Store
    Recovery["Process Recovery"] --> Store
    Recovery --> WorkQueue
```

| Module | 外部 Interface | 隐藏的 Implementation |
| --- | --- | --- |
| Async Process Runs | `submit(request, caller, idempotencyKey)`、`find(runId, caller)` | 验证、所有权、幂等、事务、状态投影和内容访问策略 |
| Process Registration | `identity`、接受输入、执行 accepted input | Schema、Definition、依赖、策略和输出验证 |
| Process Run Store | 创建、claim、转换状态、按 owner 查询、追加 outbox | SQL、事务、乐观并发、加密和 retention |
| Process Work Queue | 发布 `runId`、消费 Queue Job、关闭 | BullMQ Queue/Worker、连接、backoff、并发和 job retention |
| Process Attempt Runner | 执行一个已 claim 的 Attempt | 超时、AbortSignal、活动时间线、错误净化、retry classification 和 fencing |
| Process Events | 在状态事务中追加不可变事件 | outbox 扫描、重复发布和 reconciliation |
| Process Recovery | `recover({ mode, dryRun, cursor })` | PostgreSQL 候选、Queue inspection、Outbox ack、租约保护、审计和指标 |
| Webhook Delivery | 为事件创建 Delivery、签名、投递、重试和重放 | endpoint 策略、HTTP、secret、backoff 和审计 |
| Retention Cleaner | `runSweep({ asOf, cursor, signal })` | 到期选择、引用保护、短事务批次、审计与游标续跑 |

`Async Process Runs` 是 HTTP Adapter 与持久化、队列之间的主 Seam。`Process Work Queue` 只在内部存在，并提供 BullMQ 生产 Adapter 与确定性内存测试 Adapter。任何 BullMQ 类型、Job 状态或 Redis key 都不得越过该 Seam。

`Process Run Store` 不公开恢复扫描。Recovery Module 通过独立的 `ProcessRunRecoverySource` 读取 PostgreSQL 候选，使普通提交、查询和 Worker 调用方不需要了解恢复规则。

### Process Registration 的执行 Seam

Process Registration 已加深为两个原子动作，使同步与异步入口复用同一业务定义：

1. **accept**：解析一次外部输入，返回与准确 Process 版本绑定、可持久化的 accepted input；拒绝时不执行 Definition。
2. **run**：只执行由同一 Registration 产生的 accepted input，验证输出并返回 completion。

同步 `POST /execute` 在同一个调用中连续执行 accept 和 run；异步入口在两步之间持久化 accepted input。accepted input 必须是受大小限制的 JSON-safe snapshot，不能包含 closure、凭证或运行时对象。Worker 不应重新解释调用方的原始输入，也不能在不同版本之间回退。

同步 Interface 与 Registration 测试证明输入 transform 只发生一次、Process Definition 不会在拒绝后启动，且错误映射保持不变。

## 持久化模型

当前 PostgreSQL migration 提供以下逻辑表：

| 数据 | 必须保存的事实 | 关键约束 |
| --- | --- | --- |
| `process_runs` | owner、Process/version、状态、accepted input、公开结果、请求 fingerprint、时间戳、revision | `(owner, idempotency_key)` 唯一；状态用 compare-and-set 转换 |
| `process_run_attempts` | run、attempt number、claim token、开始/结束、结果分类 | 同一 run 的 attempt number 唯一；旧 claim 不能覆盖新状态 |
| `process_events` | event ID、类型、run、不可变 payload projection、发生时间 | 与 run 状态在同一事务提交；同一个业务事实只有一个 event ID |
| `outbox_messages` | event、目标、发布时间和 relay claim | 与对应 event 同事务提交；重复发布安全 |
| `webhook_endpoints` | owner、HTTPS URL、加密 secret、启用状态、事件选择 | URL 不直接来自运行请求；支持停用和轮换 |
| `webhook_deliveries` | event、endpoint、状态、attempt count、next attempt、最后结果 | `(event, endpoint)` 唯一；每次尝试可审计 |
| `webhook_delivery_attempts` | delivery、attempt number、时间、HTTP status、耗时和净化错误 | 不保存远端完整响应、认证信息或业务正文 |

Process Run Store 是权威状态机，不是通用日志库：

- accepted input 是异步恢复所必需的业务内容。它必须加密、按 owner 授权，并在明确保留期后删除或转为不可执行的元数据记录。
- output 使用独立内容访问策略。Webhook 和普通日志默认不复制内容。
- Prompt、Tool 过程、模型消息、隐藏推理、Secret 和远端原始错误不进入这些表。
- accepted input、公开 result、Run metadata 和 Webhook Delivery Attempt 历史分别使用 1 天、7 天、30 天和 30 天的部署模板值。前三项在写入时固化绝对到期时间；Delivery 历史在清理时按完成时间计算。所有值可由服务端环境配置，产品请求不能覆盖。
- 清理只处理终态 Run。input 与 result 到期可独立清除；metadata 删除还必须等待两者到期、Webhook outbox 已发布、Delivery 已终态且超出其独立历史期限。Run 删除通过外键一起移除 Attempt、Event、Delivery 和幂等记录，不留下失效引用。
- 清理 sweep 固定一个 cutoff，使用最多 100 行的短事务批次，并把计数与前后游标写入审计表。重复批次安全；失败批次回滚；关闭信号只在当前批次边界生效，返回的下一游标可继续同一 cutoff。
- 大对象若以后转存 Object Storage，数据库只保存受授权的引用和完整性摘要；首个版本继续受 HTTP body 与输出大小上限约束。

## BullMQ 适用性与约束

BullMQ 适合当前 Node.js 技术栈中的 Worker 调度、并发、延迟重试和横向扩容，但它不能单独满足产品持久化要求：

| BullMQ 可以负责 | BullMQ 不应负责 |
| --- | --- |
| 唤醒 Worker、锁定 active Job、并发和 backoff | 对外 Process Run 查询和 owner 授权 |
| stalled Job 恢复、有限重试和内部事件 | PostgreSQL 与 Redis 的原子提交 |
| Queue、Worker 和 QueueEvents 的运行观测 | exactly-once 业务副作用 |
| 完成/失败 Job 的受控保留与清理 | 长期结果、Webhook 审计和内容保留政策 |

生产 Adapter 遵守以下规则：

- Queue Job payload 只包含 `runId` 和 envelope schema version；输入、输出、凭证和 Webhook secret 留在 PostgreSQL。
- 自定义 Job ID 和 BullMQ deduplication 只减少重复调度，不能替代数据库状态 claim 或业务幂等。
- QueueEvents 只用于指标和排障，不能更新产品状态或成为事实来源。
- Redis 使用独立连接配置、受监控的 AOF/高可用策略和 `noeviction` 内存策略；容量告警必须早于内存耗尽，PostgreSQL outbox 保留 queue 重建来源。
- Process Registration 决定 retry policy。调用方不能指定 attempts、delay、priority 或 concurrency。
- Worker 收到关闭信号后停止领取新 Job，等待当前 Job 在宽限期内完成，再关闭 BullMQ 连接；超出宽限期的 Attempt 由租约与 stalled recovery 接管。
- 已有 PostgreSQL 终态的重复 Job 直接确认，不再次执行。BullMQ 的 completed/failed Job 只保留短期诊断窗口，长期历史留在 PostgreSQL。
- Queue Recovery 的 `stale` 和 `all` 模式使用同一修复路径。`all` 用于 Redis 数据丢失后扫描所有非终态 Run；活跃 running lease 只报告并延期，queued 与过期 running 使用稳定 `runId` 检查/补投。只有 Queue Job 已存在或成功加入后才确认 pending Process Outbox。
- dry-run 不修改 Queue 或 Outbox，但和实际修复一样写 owner-independent operator 审计与逐项分类。每个实际批次返回 missing/existing/terminal、active lease、enqueue、duplicate、Outbox ack 和 failure 指标；terminal Process Run 永不进入重建候选。
- 当前 BullMQ 版本固定在 `package-lock.json`，不使用已弃用的 `QueueScheduler`；API、Worker 与 QueueEvents 角色分别配置 Redis 重连策略。

如果部署环境不能可靠运维 Redis，应保留 `Process Work Queue` Interface，重新评估数据库型 Queue Adapter；外部 API 和 Process Run Store 不需要改变。

## 一致性与失败处理

### 接受与入队

PostgreSQL 与 Redis 没有共同事务。提交路径使用 transactional outbox：

1. 在一个 PostgreSQL 事务内写 Process Run、幂等映射和 `process_run.queued` Process Event。
2. 事务提交后立即返回 `202`，不等待 Redis。
3. Dispatcher claim 未发布 outbox，向 BullMQ 发布 `{ runId }`，再标记已发布。
4. Dispatcher 在发布成功、标记失败的窗口可能重复发布。Worker 依靠数据库 claim 保证重复 Job 不产生并发状态写入。
5. Reconciler 定期扫描长期停留在 `queued` 且没有有效调度记录的 Run，重新产生 enqueue event 或发出告警。

### 执行与重试

1. Worker 读取 Process Run，并用状态、revision 和 claim token 原子创建 Process Attempt。
2. Process Attempt Runner 使用持久化 `runId`、准确 Registration 和 accepted input 执行。
3. 成功或不可重试失败在一个事务内写终态与 Process Event。
4. 可重试失败结束当前 Attempt，把 Process Run 恢复为 `queued`，再让 Queue Adapter 按 Registration policy 调度。
5. 过期 Worker 只能结束自己的 Attempt；fencing token 阻止它覆盖较新的终态。

BullMQ 只有在 processor 抛出异常时才调度自动重试。Queue Adapter 必须把“本次 Attempt 可重试”转换为内部异常；已经写入 `succeeded` 或最终 `failed` 的业务结果正常确认 Queue Job。BullMQ Job 的 `completed`/`failed` 因此不等于 Process Run 的业务终态。

BullMQ 和网络只能提供至少一次执行。流程若会扣费、发布、发送或修改远端状态，Business Capability 必须接受由 `runId` 派生的幂等键，或使用自身事务/outbox。Worker 在远端副作用完成后、数据库写终态前崩溃时，仍可能再次执行；仅靠 BullMQ Job ID 无法消除这段窗口。

重试只覆盖已经分类的瞬时基础设施失败。`INVALID_INPUT`、`PROCESS_NOT_FOUND` 和 `INVALID_OUTPUT` 不重试；其他错误是否重试由具体 Registration 明确声明。Content Processing Capability 现在接收稳定的 `Idempotency-Key: <runId>`；其自动重试仍默认关闭，只有确认下游实际按该键去重后，部署配置才可提高最大 Attempt 数。

### 事件与 Webhook

终态和 Process Event 在同一事务写入。Webhook Dispatcher 为每个匹配 endpoint 幂等创建 Delivery，再把 delivery ID 放入独立 Queue。Delivery Worker 从数据库读取 payload 和 secret 后发送；发送结果持久化后才确认 Job。

远端收到请求但本地未记录成功时会产生重复投递，这是预期语义。Delivery 记录、有限重试、dead-letter 状态和人工重放共同提供可恢复性；Webhook 不能阻止或回滚已经完成的 Process Run。

## 安全与运行约束

- 入口继续由 TLS 网关认证。异步 API 还需要稳定的 caller identity；网关必须删除客户端伪造的身份头，或应用直接验证 token。Process Run、幂等键和 Webhook Endpoint 都按 caller 隔离。
- 当前 Gateway Adapter 使用固定的内部头 `x-pipipi-caller-id` 与 `x-pipipi-gateway-token`。网关先验证外部凭证并删除客户端同名头，再注入稳定 subject 和至少 32 bytes 的共享凭证；外部调用方不应直接构造这两个头。功能默认关闭，缺少数据库、retention 或网关凭证时 Startup Construction 拒绝启用。
- Vite 开发服务器提供唯一的非生产 Gateway Adapter。它只在显式启用的 `serve/development` mode 接受 loopback HTTP upstream，固定 caller 为 `console:development`，并从服务端环境闭包持有共享凭证。build、生产 mode 与非本机 upstream 均拒绝启用，因此凭证不进入浏览器构建、storage、响应或日志。确定性代理测试覆盖身份头替换；真实集成路径再穿过 Console Client、HTTP、PostgreSQL、Redis、Dispatcher 与 Worker。
- `GET /healthz` 不访问外部依赖；`GET /readyz` 在异步功能启用时检查 PostgreSQL 与 migration。`canary` 和 `production` 阶段还检查 durable backlog、stuck Run、Outbox lag 与最近一次成功的人工全量恢复；readiness 失败不向调用方返回内部细节。
- `runId` 使用不可预测标识，但它不是授权凭证。所有查询都检查 owner。
- 数据库和 Redis 使用不同的最小权限凭证。Secret 只由部署平台注入，不能出现在 Queue Job、日志或错误响应中。
- Webhook secret 加密保存，只在 Delivery Worker 内解密；日志只记录 endpoint ID、delivery ID、HTTP status 和错误分类。
- Webhook 签名只证明来源与正文完整性，不加密 payload；Endpoint 必须使用 HTTPS，payload 仍只发送最少元数据。
- Endpoint 注册和 URL 修改先解析全部地址并拒绝 loopback、link-local、私网、metadata、保留和其他非公网地址。Delivery 每次发送前重新解析，并通过自定义 lookup 把本次连接固定到已验证地址；HTTP client 不跟随重定向，因此 DNS rebinding 和跳转不能绕过检查。
- Endpoint 的创建、URL 修改、停用、Secret 轮换和目标拒绝都写 owner-scoped 审计事件。Secret 查询永不返回明文或加密信封；轮换窗口内只在 Worker 内解密 current/previous 两把签名 Secret。
- API、Worker、Dispatcher 和 Webhook Delivery 使用无业务内容的结构化关联日志。共同关联键是 `runId`、`eventId` 和 `deliveryId`；Outbox 还记录 `messageId`。Process Worker 还输出与同步 Runtime 相同的 Attempt/activity 事件，按 `runId + attemptNumber + sequence` 还原执行时间线。
- `observe:async` 统一读取 PostgreSQL 与两个 Queue 的运维快照；Dashboard 与告警规范覆盖 backlog、queued/Job age、queue wait、execution p95、failure rate、stuck、Outbox lag、Webhook failure、cleanup/recovery 与 storage growth。
- 新 Run 的 caller/global backlog admission 位于 PostgreSQL acceptance 事务内。幂等重放先于容量判断；达到 caller 阈值返回 `429`，达到全局阈值返回 `503`，既有 GET 始终独立可用。

## 部署形状

同一构建产物提供独立进程角色：

| 角色 | 职责 | 扩缩容依据 |
| --- | --- | --- |
| API | `/healthz`、`POST /execute`、异步提交与查询 | HTTP 延迟和请求量 |
| Process Dispatcher/Worker | outbox 入队和执行 Process Attempt | Queue depth、oldest Job age、下游配额 |
| Webhook Dispatcher/Worker | 创建并投递 Webhook Delivery | Delivery backlog 和 endpoint latency |
| Retention Cleaner | 分批删除已到期内容与 metadata | 到期候选量、删除量、deferred 数和 sweep 延迟 |
| Operations Job | 一次性读取 PostgreSQL 与两个 Queue 的无内容快照 | 固定周期运行，不接产品流量 |
| Migration Job | 在新代码接流量前执行数据库迁移 | 每个版本一次，不水平扩容 |

当前构造把 API、Process Dispatcher、Process Worker、Webhook Worker 和 Retention Cleaner 分为独立长运行角色；Operations 是一次性 Job。API 进程不在后台消费 Job，Process 与 Webhook Queue 也不共享 concurrency。

每个角色分别实现 liveness、readiness 和优雅关闭。API readiness 检查数据库；Dispatcher/Worker readiness 检查数据库与 Redis。健康检查不调用模型、Business Capability 或外部 Webhook。

## 测试策略

| 层级 | 证明的行为 | 建议环境 |
| --- | --- | --- |
| Module contract | 状态机、幂等、owner 隔离、内容策略和 retry classification | 内存 Store 与 Queue Adapter，进入默认 `npm test` |
| HTTP | `202`、`Location`、错误映射、查询投影和现有 `/execute` 不回归 | 真实本地 HTTP server |
| PostgreSQL Adapter | transaction、唯一约束、compare-and-set、outbox claim 和迁移 | 临时 PostgreSQL |
| BullMQ Adapter | 重复 Job、retry/backoff、stalled recovery、concurrency 和 graceful shutdown | 临时 Redis，不用 mock 代替关键语义 |
| Webhook Delivery | 原始 body 签名、重复、超时、状态码策略、secret 轮换和 SSRF 拒绝 | 受控本地 HTTP endpoint |
| Retention cleanup | 边界时间、重复清理、并发查询、部分失败、游标续跑和引用保护 | 临时 PostgreSQL |
| 故障注入 | API commit 后 Redis 断线、发布后未标记、Worker 崩溃、过期 claim、Webhook 断线 | 集成测试与 staging |
| Queue Recovery | Redis `FLUSHDB` 后全量重建、pending Outbox 对账、dry-run、重复 apply 和活跃/过期租约 | 临时 PostgreSQL 与独立非零 Redis DB |

所有现有同步测试必须继续通过。真实 Redis/PostgreSQL 集成测试可放入独立命令和 CI job，但状态机与 HTTP contract 的确定性测试不能依赖外部服务。

## 开发计划

开发批次、状态、代码落点、测试矩阵、迁移顺序和发布门槛统一维护在 [`async-process-runs-development-plan.md`](async-process-runs-development-plan.md)。本设计文档只维护目标结构和 invariant，避免计划状态与架构事实形成两个来源。

## 已采用的关键决策

| 决策 | 建议默认值 | 未确认时的安全行为 |
| --- | --- | --- |
| 权威存储 | PostgreSQL | 不开放异步提交 |
| 调度 | BullMQ + 托管 Redis，位于内部 Seam 后 | 保留 Queue Interface，不把 Redis 状态公开 |
| 调用方身份 | 网关验证并提供不可伪造的稳定 subject | 不开放查询和幂等共享 |
| Webhook URL | 预注册的 HTTPS endpoint | 不接受请求内任意 callback URL |
| Webhook 内容 | 只发元数据，结果由 API 查询 | 不发送 input/output |
| 重试 | 仅瞬时错误，次数由 Registration 固定 | 可能有副作用的 Process 不自动重试 |
| 内容保留 | metadata 与业务内容分开配置，内容最短必要保留 | 不长期保留 output；不记录 Agent 内部过程 |

## 暂不纳入首个版本

- 通用 Workflow 编排、动态 Process Definition 或运行时 Skill URL；
- 调用方直接访问 Queue、选择 priority/concurrency 或读取 BullMQ Job；
- exactly-once 承诺；
- Process Run 取消、暂停、定时执行、批量依赖图和流式结果；
- 公共 Attempt 明细、Webhook Endpoint 自助管理 API 和跨租户管理搜索。

这些能力以后可以在稳定 Interface 后增加，但不能改变准确 Process 版本、服务端拥有策略和调用方不上传运行配置的既有边界。
