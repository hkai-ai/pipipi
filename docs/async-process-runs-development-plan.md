# 异步 Process Run 开发计划

状态：实施中。M1–M3 已完成；M4 已完成执行、恢复与内部角色组装，待 Issue #22 补齐观测门槛。异步 Interface 默认关闭，尚未进入外部生产发布。

追踪规格：[GitHub Issue #9](https://github.com/techidsk/pipipi/issues/9)。

本文面向实现异步 Process Run 的开发者，把 [`async-process-runs-design.md`](async-process-runs-design.md) 拆成可独立合并、验证和回滚的开发批次。设计文档定义目标 Interface 和可靠性规则；本文只维护实施顺序、交付物、测试门槛和发布依赖。

## 已确认的实施基线

- 保留同步 `POST /execute`，新增 `POST /process-runs` 和 `GET /process-runs/{runId}`。
- PostgreSQL 是 Process Run、幂等键、Attempt、Process Event 和 outbox 的权威存储。
- 所有 Business Process 首期共用一个 BullMQ `process-runs` Queue 和一个可横向扩展的 Process Worker 池。Worker 根据数据库中的准确 Process/version 查找 Registration。
- Queue Job 只携带 envelope schema version 和 `runId`。外部调用方不连接 Redis，也不提交 BullMQ 配置。
- Webhook 在核心异步执行稳定后实现，并使用独立的 `webhook-deliveries` Queue，避免通知故障占用 Process Worker。
- 首个可运行版本不开放取消、BullMQ Flows、动态 Process、请求内 callback URL 或调用方自定义 retry policy。
- `ProcessRunRecords` 保持 best-effort 观测语义；新的 Process Run Store 单独承担权威状态和恢复。

## 交付顺序

```mermaid
flowchart LR
    M0["M0 决策门禁"] --> M1["M1 Runtime Seam"]
    M1 --> M2["M2 内存异步纵切"]
    M2 --> M3["M3 PostgreSQL 与查询"]
    M3 --> M4["M4 Outbox 与 BullMQ Worker"]
    M4 --> M5["M5 Webhook Delivery"]
    M5 --> M6["M6 生产硬化与发布"]
```

| 里程碑 | 状态 | 可交付结果 | 生产可见性 |
| --- | --- | --- | --- |
| M0 决策门禁 | 进行中 | 配置、身份、保留和 retry 决策固定 | 无变化 |
| M1 Runtime Seam | 已完成 | Registration 可先接受、后执行 | `/execute` 行为不变 |
| M2 内存异步纵切 | 已完成 | Async Process Runs Module 与状态机可测试 | 不组装进生产入口 |
| M3 PostgreSQL 与查询 | 已完成 | durable Run、幂等提交和查询路由 | feature flag 关闭 |
| M4 Outbox 与 BullMQ Worker | 进行中 | 一个 Process Queue 端到端执行 | 先向内部调用方开放 |
| M5 Webhook Delivery | 未开始 | 签名通知、重试、审计和重放 | 按 endpoint 灰度 |
| M6 生产硬化与发布 | 未开始 | 容量、恢复、保留、Runbook 和正式发布 | 受控发布 |

每个里程碑必须让主分支保持可构建、可测试和可部署。后续代码不能依赖尚未合并的隐藏分支；数据库迁移只做向前兼容的 additive change，删除和收紧约束留到所有旧进程退出之后。

## M0：固定实施决策

这一阶段不修改生产执行路径。它关闭会改变公开契约或数据安全的未决项。

### 任务

- 确定 PostgreSQL driver 与 migration 工具。选择标准是 Node.js 24 ESM 支持、显式事务、连接池、参数化 SQL、migration lock 和可重复 CI 执行；不让 ORM 类型进入 Process Run Store Interface。
- 确定 Redis 部署与 Queue 命名。首期每个环境只有一个 `process-runs` Queue；环境或应用前缀由部署配置提供，不按 Business Process 拆 Queue。
- 确定可信 caller identity 来源。推荐由 TLS 网关验证 service principal，删除客户端伪造的身份头，再向应用传递稳定 subject；本地测试使用显式 fake identity。
- 制定 metadata、accepted input、output、Process Attempt、幂等键和 Delivery 的 retention matrix，并确定字段级加密、删除与审计责任。
- 为当前每个 Process 建立 retry/idempotency matrix，记录是否有副作用、下游是否接受 `runId` 派生的幂等键，以及哪些公开错误可重试。
- 确定首期 Webhook Endpoint 由管理员配置，不开放调用方自助管理，也不允许请求携带 callback URL。
- 定义本地和 CI 的 PostgreSQL/Redis 集成测试环境，以及 Secret 注入方式。

### 安全默认值

- 未确认下游幂等能力的 Process 使用一次 Attempt，不自动重试。
- caller identity 未接入可信来源前，不启用异步 HTTP 路由。
- retention 未批准前，只使用非敏感测试内容，不向生产持久化业务 input/output。
- Webhook Endpoint 管理和 egress 隔离未完成前，不发送真实 Webhook。

### 已固定的实施选择

| 决策 | 当前值 | 验证方式 |
| --- | --- | --- |
| PostgreSQL driver | `pg 8.23.x`，只在 Adapter 内使用 | Pool、参数化 SQL、跨 Pool contract tests |
| migration 工具 | `node-pg-migrate 9.x`，默认事务与 advisory lock | 空库执行后再次执行不产生 migration |
| 本地 PostgreSQL | `compose.integration.yaml` 的 PostgreSQL 17 临时实例 | `npm run test:integration:postgres` |
| migration 配置 | `DATABASE_URL`；测试单独使用 `POSTGRES_TEST_DATABASE_URL` | 测试数据库名必须以 `_test` 结尾 |
| 可信 caller identity | 网关验证 principal，删除外部同名头，再注入 caller subject 与共享凭证 | 应用对共享凭证做定时安全比较；缺失或伪造身份返回 `401` |
| BullMQ / Redis client | `bullmq 6.0.9`、`ioredis 6.0.0`，首期 `attempts=1` | 依赖精确锁定；真实 Redis 集成测试 |
| Process Queue | 一个 `process-runs` Queue；默认 key prefix 为 `pipipi` | 两个不同 Process 通过同一 Queue 选择准确 Registration |
| 本地 Redis | `compose.integration.yaml` 的 Redis 7.4、`noeviction`、临时数据目录 | `REDIS_TEST_URL` 必须指向本机非零 database |

生产 Redis 高可用、生产 retention、字段级加密和 retry matrix 仍由后续批次固定，因此 M0 继续保持“进行中”。

### 完成门槛

- 上述决定都有明确值、配置归属和测试判据。
- 新增配置名可以写入 `.env.example`，但这一阶段不加入真实 Secret。
- 设计文档中的所有“实施前必须确认”项都有结论或安全默认值。

## M1：加深 Process Runtime Seam

目标是把“接受输入”和“执行 Definition”分开，同时保持同步 Interface 完全兼容。

### Interface 变化

- Process Registration 提供原子的 `accept(input)` 与 `run(acceptedInput, context)`。
- accepted input 是与准确 Process identity 绑定的、受大小限制的 JSON-safe snapshot。外部调用方不能构造或修改它。
- Process Attempt Runner 接收预先分配的 `runId`，负责超时、AbortSignal、输出验证和公开错误净化。
- 现有 `ProcessExecutor.execute(request)` 继续生成同步 `runId`，在一次调用内依次完成 accept 和 run，因此 HTTP Adapter 无需学习新顺序。

具体 TypeScript 形状先用测试约束，不把持久化格式、Zod 类型或 Registration 私有泛型暴露给 HTTP 调用方。

### 实现任务

- 在现有 Process Runtime 内抽出 accepted input 与 Attempt execution，不先为每个 helper 建文件或公共 Interface。
- 让 `defineProcessRegistration` 保持 Schema、Definition、依赖和策略的 Locality。
- 为 accepted input 增加 JSON-safe、最大尺寸、identity/version 和 schema version 校验。
- 允许内部 Attempt execution 使用提交阶段提供的 `runId`。
- 保留 `ProcessRunRecords` 的同步完成记录行为和现有错误映射。

### 测试

- 输入 Schema transform 在一次 Process Run 中仍只执行一次。
- rejected input 不启动 Definition，也不产生 accepted input。
- accepted input round-trip 后执行结果与同步直接执行一致。
- 预先分配的 `runId` 进入 Execution Context 和最终结果。
- 超时、AbortSignal、预期失败、意外异常和无效输出保持现有结果。
- 全部现有 `/execute` 测试不修改预期即可通过。

### 完成门槛

- `npm run typecheck`、`npm test` 和 `npm run build` 通过。
- 删除新的 Attempt Runner 后，`runId`、超时、错误净化和 accepted input 执行会重新散落到同步与异步调用方；该 Module 通过 deletion test。
- 生产 catalog、公开路由和环境配置没有变化。

## M2：实现内存异步纵切

目标是在不依赖 PostgreSQL 或 Redis 的情况下，先固定 Async Process Runs Module 的 Interface 与状态机。

### Interface

```ts
type AsyncProcessRuns = Readonly<{
  submit: (
    request: unknown,
    context: { callerId: string; idempotencyKey: string },
  ) => Promise<ProcessRunSubmission>;
  find: (
    runId: string,
    context: { callerId: string },
  ) => Promise<ProcessRunView | undefined>;
}>;
```

`ProcessRunSubmission` 是 accepted/rejected union：accepted 返回 `runId` 和初始状态；rejected 只返回 `INVALID_INPUT`、`PROCESS_NOT_FOUND` 或 `IDEMPOTENCY_CONFLICT` 等稳定公开错误，不创建 Process Run。数据库等意外故障以内部异常离开 Module，再由 HTTP Adapter 净化为可重试的传输错误。

调用方只学习 `submit` 和 `find`。幂等 fingerprint、状态转换、Attempt、outbox 和内容策略全部留在 Implementation。

### 实现任务

- 定义 `queued`、`running`、`succeeded`、`failed` 的公共状态和允许的转换。
- 实现 Async Process Runs Module，复用 Process Registry 做精确版本查找和输入接受。
- 定义内部 Process Run Store Seam，并提供有界内存 Adapter；生产 PostgreSQL Adapter 在 M3 加入。
- 定义内部 Process Work Queue Seam，并提供确定性内存 Adapter；生产 BullMQ Adapter 在 M4 加入。
- 实现 caller-scoped idempotency、request fingerprint 和 owner 隔离。
- 实现测试用 Worker drain：读取一个 `runId`、claim Attempt、执行准确 Registration、写终态。
- 保持同步 Run Record 与异步 Process Run Store 分离。

### 测试

- 相同 caller/key/request 返回同一个 `runId`，不会产生第二个 Queue Job。
- 相同 caller/key 配合不同 request 返回 `IDEMPOTENCY_CONFLICT`。
- 不同 caller 可以安全复用同一个 idempotency key，但不能读取彼此的 Run。
- 无效 envelope、未知 Process 和无效业务输入不会创建 durable Run。
- 重复 Queue Job、重复 claim 和迟到 Attempt 不能覆盖已存在终态。
- 同一个统一 Queue 可以执行不同 Process/version，并使用各自 Registration。
- 查询只返回公共状态、已授权内容和净化错误。

### 完成门槛

- 所有行为通过 `AsyncProcessRuns.submit/find` 和测试 Worker 的生命周期验证，不读取 Adapter 私有 Map。
- 内存 Adapter 有界、返回防御性副本，并且只用于测试或本地开发。
- Async Process Runs 尚未进入 Startup Construction，生产行为不变。

## M3：接入 PostgreSQL 与异步 HTTP

目标是让 Process Run 在进程和实例之间持久存在，并固定提交、查询和授权契约。

实现进度：Issue #12 完成第一批 migration、PostgreSQL Store、事务 Outbox、跨实例 contract tests 和内容过期字段；Issue #13 完成异步 HTTP、可信 caller identity、默认关闭的 feature flag、资源关闭与数据库 readiness。自动内容清理由 Issue #21 按 M6 规则实现。

### 数据库任务

- 第一批 migration 只创建 `process_runs`、`process_run_attempts`、`process_events` 和 `outbox_messages`。
- 用唯一约束实现 `(caller_id, idempotency_key)`；保存 request fingerprint 以识别冲突。
- 用 revision、claim token 和受控 SQL transition 防止旧 Attempt 覆盖新状态。
- 在同一事务中写 accepted Process Run、`process_run.queued` Event 和 outbox message。
- 实现 PostgreSQL Process Run Store Adapter，并与内存 Adapter 共享同一 contract test suite。
- 增加过期字段和内容清理入口，但在 M6 前不自动执行破坏性清理。

### HTTP 任务

- 在 HTTP Adapter 中增加 `POST /process-runs` 和 `GET /process-runs/{runId}`，继续保留 `/execute`。
- `POST` 要求 `Idempotency-Key`，durable transaction 成功后返回 `202`、`Location` 和 `Retry-After`。
- `GET` 对已授权资源返回 `200`；未知或无权访问都返回 `404`。非终态响应带 `Retry-After` 和 `Cache-Control: no-store`。
- 增加 caller identity resolver，并保证生产 Adapter 只接受网关提供的可信身份。
- 通过 feature flag 和完整配置组装异步 Module。缺少数据库、身份或必要配置时，启动阶段明确失败或保持异步路由关闭。
- 增加内部 `GET /readyz` readiness，检查异步功能需要的数据库连接；`/healthz` 继续只做 liveness，不访问数据库、模型或 Business Capability。

### 测试

- migration 可在空数据库执行，也可幂等检测已应用版本。
- API 实例 A 提交后，实例 B 可以查询同一 Run。
- API 在 commit 前崩溃不会留下可见的半成品；commit 后断线时，重放同一 key 返回已有 Run。
- 数据库不可用、唯一约束竞态和乐观并发冲突映射为稳定行为。
- caller identity 缺失、伪造或跨 owner 查询被拒绝，响应不泄露资源存在性。
- `/execute` 的全部同步契约继续通过。

### 完成门槛

- PostgreSQL Adapter 集成测试使用真实临时 PostgreSQL，不以 mock SQL 代替事务和约束。
- 异步路由默认关闭；M4 的真实 Worker 就绪前不能向生产调用方开放。
- schema migration、配置样例和本地启动说明已经文档化。

## M4：接入 transactional outbox 与 BullMQ Worker

目标是让所有 Business Process 通过一个内部 Queue 可靠执行，并让 Redis 故障不会丢失已接受 Run。

实现进度：Issue #14 已完成 Outbox claim/ack、统一 BullMQ Queue、最小 Job envelope、基础 Worker 生命周期和有界 Job retention。Issue #15 已完成过期租约接管、旧 token fencing、Reconciler、Redis/Dispatcher 故障恢复，以及有期限的优雅停机。Issue #16 已把 API、Dispatcher、Worker 组装成独立角色，并用真实 HTTP/PostgreSQL/Redis 验证成功、业务失败和 caller 隔离。Issue #17 已增加 Registration 所有的受控重试策略、稳定下游幂等键、queued 等待状态与真实 BullMQ 延迟重投。Issue #22 继续补齐 M4 所需指标和告警，因此本里程碑保持“进行中”。

### 实现任务

- 固定 BullMQ 版本，增加独立 Redis 连接配置和 `process-runs` Queue Adapter。
- Queue Job 使用固定 schema：`{ schemaVersion: 1, runId }`，并把 `runId` 作为自定义 Job ID 的辅助防重。
- 实现 Outbox Dispatcher：claim 未发布 message、`queue.add()`、成功后确认；发布后确认前崩溃允许重复发布。
- 实现独立的 Dispatcher 与 Process Worker Application/入口，各自拥有 `start/close` 生命周期和角色专属依赖。
- Worker 从 PostgreSQL读取 Run，创建带 claim token 的 Process Attempt，并通过 M1 的 Attempt Runner 执行。
- 初始 Job `attempts=1`。只有 M0 retry matrix 和下游幂等完成后，才按 Registration policy 开启自动重试与 backoff。
- 把可重试 Attempt 转换为 BullMQ processor 抛错；最终业务失败正常确认 Queue Job。BullMQ Job 状态不进入 Process Run 响应。
- 实现 queued Run reconciliation、重复 Job 短路、stale claim fencing 和有界 Job retention。
- 实现 Worker graceful shutdown、Redis error listener、liveness/readiness 和结构化日志。
- 同一 Docker image 增加 API、Dispatcher 与 Process Worker 三种明确启动命令；API 进程不消费 Job。

### 测试

- PostgreSQL commit 后 Redis 断线，outbox 保留；恢复后 Run 最终执行。
- `queue.add()` 成功但 outbox 未确认时重启 Dispatcher，重复 Job 不产生第二个终态。
- 两个 Worker 并发收到同一 `runId` 时，只有一个有效 claim；迟到 Worker 不能覆盖终态。
- Worker 崩溃或失去 BullMQ lock 后允许再次执行，但数据库状态安全，副作用使用相同 `runId` 幂等键。
- 同一个 Queue 连续执行两个不同 Business Process，Registration 选择和结果都正确。
- graceful shutdown 停止领取新 Job，并在部署宽限期内等待 active Job。
- BullMQ Job 清理和 QueueEvents 裁剪不影响 `GET /process-runs/{runId}`。

### 完成门槛

- PostgreSQL 与 Redis 故障注入证明“允许重复、不丢已接受 Run”。
- 内部调用方能提交、轮询并获得终态；重复提交和重复 Job 不产生第二个 Process Run。
- 指标至少覆盖 queue depth、oldest Job age、outbox age、Attempt 结果和 stalled count。
- 通过受控 feature flag 向内部调用方开放，不替换同步 `/execute`。

## M5：实现可靠 Webhook Delivery

目标是增加不影响 Process Run 终态的完成通知。

### 实现任务

- 第二批 migration 增加 `webhook_endpoints`、`webhook_deliveries` 和 `webhook_delivery_attempts`；Process Event 继续复用 M3 的不可变记录。
- 首期通过管理员配置或内部 Interface 注册 Endpoint，绑定 owner、HTTPS URL、事件选择和加密 secret。
- 终态事务同时写 Process Event 与 Webhook outbox message；Dispatcher 为每个匹配 Endpoint 幂等创建 Delivery。
- 增加独立 `webhook-deliveries` Queue、Dispatcher 和 Delivery Worker，不复用 Process Worker concurrency。
- 按 Standard Webhooks 对最终原始 body 生成 `webhook-id`、`webhook-timestamp` 和 `webhook-signature`。
- 只发送 thin payload；调用方使用自己的 API 凭证查询 output。
- 任意 `2xx` 结束 Delivery；`410` 停用 Endpoint；其他失败在总投递期限内按指数 backoff、jitter 和有效 `Retry-After` 重试。
- 保存每次 Delivery Attempt 的时间、状态码、耗时和净化错误；不保存远端完整响应正文。
- 实现失败列表和受审计的人工 replay；重复投递沿用同一个 event ID。
- 在网络层和应用层阻止私网、loopback、link-local、云 metadata、非 HTTPS 与不受控 redirect。

### 测试

- 原始 body、message ID 和 timestamp 任一变化都会导致验签失败。
- secret 轮换期间 current/previous secret 均可验证，日志不包含 secret。
- receiver 已处理但 Worker 写成功前崩溃会造成重复 Delivery，event ID 保持不变。
- timeout、TLS/DNS、`3xx`、`410`、`429` 和 `5xx` 分别执行规定策略。
- 一个故障 Endpoint 不阻塞其他 Endpoint，也不改变已完成 Process Run。
- SSRF 测试覆盖直接 IP、DNS rebinding、redirect 和云 metadata 地址。

### 完成门槛

- Webhook 失败可查询、可告警、可重放，调用方始终可通过 GET 恢复结果。
- Webhook Queue backlog 不占用 Process Queue concurrency。
- 消费者验签、去重和轮询回退文档已经完成。

## M6：生产硬化与发布

### 实现任务

- 实现 retention cleanup，并按批准的期限分别清理 accepted input、output、Attempt、Event、Delivery 和幂等键。
- 完成数据库备份恢复、Redis queue 重建、outbox reconciliation 和 stuck Run 修复工具。
- 为 API、Process Worker 和 Webhook Worker 分开配置实例数、连接池、concurrency、rate limit 和 termination grace period。
- 增加 backlog admission；超过 durable backlog 上限时在 commit 前返回 `429` 或 `503`，并带 `Retry-After`。
- 增加 dashboard 与告警：queued age、Run stuck age、outbox lag、Attempt 失败、stalled、Webhook retry age 和 dead-letter。
- 更新 `.env.example`、Dockerfile、开发文档、异步 release runbook、迁移步骤和回滚步骤。
- 在 staging 注入数据库、Redis、Worker、网络和 Webhook 故障，再进行内部 dark launch 和限量灰度。

### 发布门槛

- API 返回 `202` 后停止 API、Dispatcher、Worker 或 Redis 中的任一项，恢复后 Run 仍能到达终态。
- 数据库恢复演练能重建尚未完成的 Queue Job，并保留 owner、幂等和查询结果。
- 同步 `/execute` 的延迟、错误映射和容量门禁没有回归。
- 回滚旧 API/Worker 不会读取不兼容 schema，也不会删除已接受 Run。
- 安全评审覆盖 caller identity、内容保留、Webhook egress、Secret 和日志。

## 计划中的代码落点

文件名可在实现时按 Locality 调整；Module 和 Interface 责任不得散落。

| 代码区域 | 计划变化 |
| --- | --- |
| `src/process-runtime.ts` | M1 的 accept/run、accepted input 和 Attempt execution |
| `src/business-process-executor.ts` | 复用同一 production catalog 组装同步与异步执行核心 |
| `src/async-process-runs.ts` | Async Process Runs 的 `submit/find` 外部 Interface 与状态投影 |
| `src/process-run-store.ts` | 内部 Store Seam、状态转换类型和内存 Adapter |
| `src/postgres-process-run-store.ts` | PostgreSQL Adapter 与事务 Implementation |
| `src/process-work-queue.ts` | Queue Job schema、内存 Adapter 与内部发布/消费 Interface |
| `src/bullmq-process-work-queue.ts` | BullMQ Queue/Worker Adapter 与 Redis 配置 |
| `src/outbox-dispatcher.ts` | outbox claim、发布、确认和 reconciliation |
| `src/process-worker.ts`、`src/process-worker-main.ts` | Worker 生命周期和 composition root |
| `src/http-adapter.ts`、`src/application.ts` | 异步路由、caller identity 和 readiness，保留同步路由 |
| `src/startup-construction.ts` | feature flag、数据库/Redis Adapter 和角色组装 |
| `src/webhook-*.ts` | M5 的 Endpoint、Delivery、签名、Queue 与 Worker |
| `migrations/` | 分批、向前兼容的 PostgreSQL migration |
| `test/` | Module contract、HTTP 和受控故障测试 |

不要让 HTTP Adapter 直接写 SQL 或调用 BullMQ，也不要让 Worker 重新实现 Registration 查找、超时和错误净化。`Async Process Runs` 应隐藏调用方身份、幂等、状态机和内容策略；Store、Queue 和 Webhook 是它的内部 Seam。

## 合并批次

建议按以下顺序形成可评审改动；每批都单独通过仓库门禁：

1. Runtime accept/run 重构与同步回归测试。
2. Async Process Runs、内存 Store/Queue 和状态机 contract tests。
3. PostgreSQL migrations、Store Adapter 和集成测试。
4. caller identity、异步 HTTP 路由和 feature flag。
5. Outbox Dispatcher、统一 BullMQ Process Queue 和 Worker 入口。
6. reconciliation、retry policy、指标与故障测试。
7. Webhook schema、独立 Queue、签名、投递与 replay。
8. retention、部署资源、Runbook 和受控发布。

不要把 PostgreSQL、BullMQ、HTTP、Webhook 和部署配置压进一个无法独立评审的大提交。每批只在前一个 Interface 已稳定时开始；发现设计需要变化时先更新设计文档，再修改后续批次。

## 验证命令计划

现有确定性门禁保持不变：

```bash
npm run typecheck
npm test
npm run build
```

实现阶段计划新增独立集成命令，准确名称在 M0 固定：

```bash
npm run test:integration:postgres
npm run test:integration:redis
npm run test:integration:async
```

默认 `npm test` 覆盖纯 Module 与本地 HTTP 行为，不要求 Docker、网络或真实凭证。PostgreSQL/Redis 集成命令使用临时受控实例并在 CI 单独运行；staging 故障注入不得混入默认测试。

## 整体完成定义

- 外部调用方只学习提交、查询和可选 Webhook，不知道 BullMQ、Redis、Attempt 或 outbox。
- 所有 Business Process 通过一个 Process Queue 执行，新增 Process 不需要新 Queue 或新 Worker 类型。
- 返回 `202` 的 Run 可以跨 API/Worker 重启、Redis 短暂故障和 outbox 重放恢复。
- 查询按 caller 隔离，幂等重放不创建第二个 Run，过期内容按已批准策略删除。
- 至少一次执行和至少一次 Webhook Delivery 不会产生未经控制的重复业务副作用。
- Webhook 失败不改变 Process Run 终态，调用方始终可以通过查询恢复。
- 现有同步 `/execute`、生产 catalog、Skill 安全边界和公开错误保持兼容。
- 类型检查、默认测试、构建、PostgreSQL/Redis 集成测试和 staging 故障门禁全部通过。
