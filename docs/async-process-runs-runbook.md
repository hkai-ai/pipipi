# 异步 Process Run 发布与运维手册

本文面向发布、SRE 和值班人员，用于部署、灰度、观测、恢复与回滚 Async Process Runs。它只覆盖已经随应用发布、由服务端选择的 Business Process；调用方仍不能提交 Queue、步骤、Skill、脚本、模型、Tool、callback URL 或运行配置。同步 MVP 继续使用 [`mvp-release-runbook.md`](mvp-release-runbook.md)。

## 运行结论

PostgreSQL 是 Run、幂等键、Attempt、Event、Outbox、Delivery、清理和恢复审计的事实来源。BullMQ 只负责唤醒 Worker；Redis 丢失后可以从 PostgreSQL 重建非终态 Job。API、Process Dispatcher、Process Worker、Webhook Worker 和 Retention Cleaner 必须作为独立角色运行，外部服务只通过可信网关调用 HTTP API。

```mermaid
flowchart LR
    Caller["可信调用方"] --> Gateway["认证网关"]
    Gateway --> API["Process API"]
    API --> PG[("PostgreSQL")]
    PG --> Dispatcher["Process Dispatcher"]
    Dispatcher --> PQ["BullMQ Process Queue"]
    PQ --> Worker["Process Worker"]
    Worker --> PG
    PG --> WH["Webhook Worker"]
    WH --> WQ["BullMQ Webhook Queue"]
    WQ --> WH
    Cleaner["Retention Cleaner"] --> PG
    Observer["Operations snapshot"] --> PG
    Observer --> PQ
    Observer --> WQ
```

`ASYNC_PROCESS_RUNS_ENABLED` 默认是 `false`。设置为 `true` 还必须给出 `ASYNC_RELEASE_STAGE=internal|canary|production`、持久化期限、网关 Secret 和 backlog admission 上限。`internal` 只允许私网测试流量；`canary` 与 `production` 的 API readiness 会额外执行容量、stuck Run、Outbox 延迟和最近人工全量恢复门禁。

## 发布前置条件

候选提交必须先通过确定性与真实依赖验证：

```bash
npm ci
npm run typecheck
npm test
npm run build

docker compose -f compose.integration.yaml up -d --wait
export POSTGRES_TEST_DATABASE_URL=postgres://pipipi:pipipi-test-only@127.0.0.1:55432/pipipi_test
export REDIS_TEST_URL=redis://127.0.0.1:56379/15
npm run test:integration:postgres
npm run test:integration:async
docker compose -f compose.integration.yaml down
```

集成测试会重建名称以 `_test` 结尾的 schema，并清空明确的本机非零 Redis database。不要把生产 URL 传给这些命令。

发布人员还必须确认：

- PostgreSQL 已完成备份与恢复验证，Redis 使用内部网络、认证、`noeviction` 和批准的高可用形状；
- 网关删除外部同名身份头，再注入 `x-pipipi-caller-id` 与 `x-pipipi-gateway-token`；容器端口不能绕过网关访问；
- `WEBHOOK_SECRET_ENCRYPTION_KEY`、网关 Secret 和数据库/Redis 凭证通过 Secret 管理器注入，彼此最小授权；
- Business Capability 已按 `runId` 支持幂等后，才能把 Registration 的最大 Attempt 从 1 提高；
- 观测系统已经导入 [`ops/async-observability.json`](../ops/async-observability.json)，并能按 `runId`、`eventId` 和 `deliveryId` 检索单行 JSON 日志；
- 已批准 accepted input、result、metadata 和 Delivery history 的期限与数据库容量预算。

## Migration 与部署顺序

所有 migration 必须由一次性 Job 在新代码接流量前执行：

```bash
DATABASE_URL='postgres://service-user:replace-me@database.internal/business_processing' \
npm run db:migrate
```

当前 migration `001` 至 `007` 采用向前兼容的表、列和索引变化。`007_process_run_admission` 只增加 caller backlog 部分索引，旧进程可以继续读写。按照以下顺序部署：

1. 记录旧镜像摘要、当前 migration 版本、数据库备份 ID、Queue prefix 和基线运维快照。
2. 运行 migration Job；再次运行 `npm run db:migrate` 必须显示无待执行 migration。
3. 先部署 Retention Cleaner、Process Dispatcher、Process Worker 和 Webhook Worker，但不接外部流量；所有角色的 `/readyz` 必须为 `200`。
4. 运行一次人工全量 Queue Recovery dry-run，保存 `recoveryId` 与零失败报告。
5. 部署 API，保持 `ASYNC_RELEASE_STAGE=internal`，只允许内部合成调用方提交和查询。
6. 采集至少一个正常观测窗口，完成故障演练，再依次提升到 `canary` 和 `production`。

同一 Queue 上滚动升级 Worker 时，先让新 Worker ready，再停止旧 Worker 领取新 Job，并给旧 Worker 至少 `PROCESS_WORKER_SHUTDOWN_GRACE_MS` 完成或释放 claim。Job envelope 始终只有 `{ schemaVersion: 1, runId }`；新旧 Worker 都从 PostgreSQL 选择准确 Registration。不要同时改变 schema、Process 语义和 Queue prefix。

## 配置与分阶段启用

以下配置是 API 开启异步入口时的完整组。示例值是容量规划起点，不是所有环境的固定生产值：

| 配置 | 示例 | 作用 |
| --- | ---: | --- |
| `ASYNC_PROCESS_RUNS_ENABLED` | `false` | 总开关；默认关闭 |
| `ASYNC_RELEASE_STAGE` | `internal` | `internal`、`canary` 或 `production` |
| `ASYNC_GLOBAL_BACKLOG_LIMIT` | `1000` | 全局 queued + running Run 上限 |
| `ASYNC_CALLER_BACKLOG_LIMIT` | `100` | 单 caller 上限，不能高于全局上限 |
| `ASYNC_BACKLOG_RETRY_AFTER_SECONDS` | `5` | admission 拒绝的 `Retry-After` |
| `ASYNC_STUCK_RUN_AGE_MS` | `300000` | queued Run 判定为 stuck 的年龄 |
| `ASYNC_MAX_STUCK_RUNS` | `0` | canary/production readiness 可接受的 stuck 数 |
| `ASYNC_MAX_OUTBOX_LAG_MS` | `60000` | canary/production readiness 的 Outbox 延迟上限 |
| `ASYNC_RECOVERY_MAX_AGE_MS` | `86400000` | 最近成功人工全量恢复报告的最大年龄 |

其余数据库、Redis、Queue、Worker、Webhook、retention 和 Secret 配置以 [`.env.example`](../.env.example) 为准。API 与 Worker 必须使用相同的三个 `PROCESS_RUN_*_RETENTION_MS`；Dispatcher 与 Process Worker 必须使用相同 `PROCESS_QUEUE_NAME/PREFIX`；Webhook Worker 单独使用 `WEBHOOK_QUEUE_NAME/PREFIX`。

阶段切换遵守以下门禁：

| 阶段 | 流量 | 必须满足 |
| --- | --- | --- |
| off | 无异步路由 | `ASYNC_PROCESS_RUNS_ENABLED=false`；同步 `/execute` 保持可用 |
| internal | 内部合成与受控服务 | migration 完成、所有角色 ready、身份与 Secret 检查、提交/查询/Webhook smoke 通过 |
| canary | 1% → 5% → 25% 授权流量 | backlog 低于上限、stuck 不超阈值、Outbox 延迟达标、最近人工全量恢复成功、Dashboard 与告警工作 |
| production | 逐步提升到批准比例 | canary 至少跨一个峰值窗口无 critical alert，容量与费用在预算内，回滚负责人在线 |

每次提升只改变一个变量，并记录开始时间、流量比例、镜像摘要和观测快照。任何 readiness 或 critical alert 失败都停止提升；不要通过临时放大阈值绕过门禁。

## 容量拒绝与恢复

API 在 PostgreSQL 接收事务内先处理幂等重放，再串行检查 queued + running backlog。相同 caller/key/fingerprint 的重放不消耗新名额，也不会因 backlog 已满而失败。

| 条件 | HTTP | 稳定错误码 | 调用方动作 |
| --- | ---: | --- | --- |
| caller 达到上限 | `429` | `CALLER_BACKLOG_LIMIT_REACHED` | 等待 `Retry-After`，继续查询既有 Run |
| 全局达到上限 | `503` | `ASYNC_SERVICE_CAPACITY_REACHED` | 等待 `Retry-After`，继续查询既有 Run |
| PostgreSQL 或身份依赖不可用 | `503` | `ASYNC_SERVICE_UNAVAILABLE` | 等待 `Retry-After`；不要创建新 idempotency key |

admission 只拒绝新 durable Run，`GET /process-runs/{runId}` 不经过 backlog 门禁。收到容量告警后先确认 Process Worker、下游配额、Outbox 和 Queue age，再扩容 Worker 或修复下游。只有数据库、下游费用和恢复窗口都能承受时才提高上限。

## 运维快照、Dashboard 与日志

在源码工作区采集一次快照：

```bash
DATABASE_URL='postgres://service-user:replace-me@database.internal/business_processing' \
REDIS_URL='rediss://redis.internal:6379/0' \
npm run observe:async
```

生产镜像使用已编译入口：

```bash
npm run start:operations
```

命令只读取 PostgreSQL 与两个 BullMQ Queue，输出一行 `async_operations_snapshot` JSON 后退出。通过受信定时 Job 每 30–60 秒运行并导入指标系统；不要把它暴露成公网 HTTP 路由。`ASYNC_OPERATIONS_RECENT_WINDOW_MS` 控制 failure rate 和 p95 的统计窗口。

Dashboard 与告警的 vendor-neutral 规范位于 [`ops/async-observability.json`](../ops/async-observability.json)，必须至少展示：

| 信号 | 字段或日志 | 解释 |
| --- | --- | --- |
| 接收延迟 | `process_run_submission_accepted.durationMs` | API 验证与 PostgreSQL durable acceptance 延迟 |
| Queue 等待 | `persistence.runs.queueWaitP95Ms`、`queues.process.oldestRunnableAgeMs` | durable Run 到首次 Attempt 与 Redis Job 年龄 |
| 执行耗时 | `persistence.runs.executionP95Ms` | 首次开始到终态的近期 p95 |
| 失败与 stuck | `failureRateRecent`、`persistence.runs.stuck` | 业务/依赖失败和长期 queued/租约过期 Run |
| Outbox | `oldestProcessLagMs`、`oldestWebhookLagMs` | PostgreSQL commit 到入队确认的延迟 |
| Webhook | `persistence.webhooks.failureRateRecent`、`oldestPendingAgeMs` | 终态投递失败和重试积压 |
| Storage | `persistence.storage.asyncTablesBytes` | 当前体积；监控系统计算日增长率 |
| Cleanup/Recovery | `lastDeferredRuns`、`lastFailedItems`、完成时间 | 内容清理受引用阻塞或 Queue 恢复失败 |

结构化日志的关联链为：API/Worker 使用 `runId`，Outbox 同时使用 `messageId + eventId + runId|deliveryId`，Webhook Attempt 使用 `deliveryId + eventId`。日志不得包含 caller 原始凭证、idempotency key、accepted input、output、Webhook payload、Endpoint URL、签名 Secret、数据库/Redis URL、远端响应正文或内部异常消息。需要查看业务结果时，使用 owner-authenticated GET；不要从日志还原内容。

## Queue 对账与 Redis 重建

人工恢复默认 dry-run，必须给出可审计 actor：

```bash
PROCESS_RECOVERY_ACTOR_ID=operator:replace-me \
npm run recover:queue -- --mode=all

PROCESS_RECOVERY_ACTOR_ID=operator:replace-me \
npm run recover:queue -- --apply --mode=all
```

先保存 dry-run 的 candidate、missing、terminal、invalid、active lease、pending Outbox 和 failed 计数。只有 `failed=0` 且影响范围符合事故判断时执行 `--apply`。恢复命令以 PostgreSQL 非终态 Run 为候选；终态 Run 不会重建。活跃 running 租约只报告 `deferred`，过期后下一轮才重入队。成功入队或确认有效 Job 后才确认 pending Outbox。

Redis 数据丢失的标准动作：

1. 把异步 API 降到 `internal` 或关闭新提交；保留 GET 查询。
2. 停止 Dispatcher 自动写 Queue，等待当前恢复批次结束。
3. 恢复 Redis 服务和正确 Queue prefix，确认两个 Queue ready。
4. 执行全量 dry-run；保存报告。
5. 执行全量 `--apply`，重复 dry-run 直到 missing/invalid/failed 都为零。
6. 恢复 Dispatcher 与 Worker，观察 queued age、Outbox lag、重复/ignored 日志和终态增长。
7. 重新通过 canary readiness 后再增加流量。

不要把 Queue count 当作产品 backlog，也不要删除 PostgreSQL Run 来“清空队列”。

## 故障演练

每个候选版本至少在 staging 完成以下演练，并保存时间、镜像、配置、Run ID、恢复报告和结果。

### 数据库 migration 兼容

1. 用旧镜像创建 queued 与 terminal Run，保存 owner 查询结果。
2. 保持旧 API/Worker 运行并执行 additive migration；旧同步和异步查询必须继续工作。
3. 部署新后台角色与 `internal` API，提交新 Run 并到达终态。
4. 在旧 Worker 退出前不要启动内容清理；确认新 schema 没有让旧代码读取已清空的 input/result。
5. 回滚新 API/Worker 但保留 additive schema，确认旧查询仍可用。

### Worker 滚动升级

1. 创建足以覆盖两个 Worker 的 Run，并记录 `runId`。
2. 启动新 Worker，确认 ready 后让旧 Worker 停止领取。
3. 在旧 Worker 执行中触发停机；宽限期内完成，或由旧 Worker释放 claim。
4. 确认每个 Run 只有一个终态，迟到 claim token 不能覆盖新 Attempt。
5. 对比升级前后 queue wait、execution p95 与 failure rate。

### Redis 故障与 Queue 重建

1. API 返回 `202` 后停止 Redis；确认 Run 仍可 GET，Process Outbox 保持 pending。
2. 恢复 Redis 与 Dispatcher，确认普通 Outbox relay 能最终入队。
3. 在隔离 staging Redis 执行数据清空，按“Queue 对账与 Redis 重建”完成 dry-run/apply。
4. 确认 queued 与租约过期 running Run 到达终态，活跃租约未被提前抢占，terminal Run 未重跑。

### Webhook 隔离

1. 让测试 Endpoint 返回 `503` 或超时；Process Run 必须仍成功或按业务结果失败。
2. 确认 Delivery 按 PostgreSQL 策略重试，Process Queue latency 不受 Webhook backlog 影响。
3. 恢复 Endpoint 或执行受审计 replay；相同 Event 使用稳定 `eventId`，接收方去重。
4. 验证日志没有 URL、payload、Secret 或响应正文。

### 回滚

1. 把新提交流量降到零；必要时设置 `ASYNC_PROCESS_RUNS_ENABLED=false`，同步 `/execute` 继续服务。
2. 让已接受 Run 由兼容 Worker 排空；若必须停 Worker，保留 PostgreSQL 并在恢复后重建 Queue。
3. 回滚应用镜像，不自动执行 migration down。验证 health/readiness、既有 GET 和同步回归。
4. 修复后用同一 PostgreSQL 数据与 Queue prefix 恢复，先 dry-run Queue Recovery，再 internal/canary。

## 告警处置

### Run 或 Process Queue 持续增长

比较 PostgreSQL `queued/running` 与 BullMQ waiting/active/delayed。若 PostgreSQL 增长但 Queue 为空，检查 Outbox 和 Dispatcher，再运行 Queue Recovery dry-run；若 Queue 与 active 同时增长，检查 Worker readiness、Business Capability 配额、执行耗时和超时。不要先增加 API backlog 上限。

### Outbox 延迟

确认 Dispatcher ready、Redis 可达和 Queue prefix 一致。检查 Outbox claim 是否过期；普通故障恢复后 relay 会重试。持续不一致时运行 dry-run，对 `pendingOutbox` 候选执行受控 apply。只有有效或新建 Job 才允许确认 Outbox。

### Webhook 失败或积压

先区分单 Endpoint 与全局网络问题。`410` 和 target rejection 会停用 Endpoint；`429/5xx/network` 按策略重试。确认 Process Run 终态未改变，必要时隔离故障 Endpoint或扩容独立 Webhook Worker。只有目标恢复且 actor 有权限时执行 replay。

### 存储增长或清理滞后

检查 `asyncTablesBytes` 日增长、最近 cleanup 时间和 `lastDeferredRuns`。deferred 通常表示 pending Outbox 或仍在保留期内的 Delivery 引用，先修复投递链。不要手工删除关联行。`005_retention_cleanup` 已清空内容后不能安全回滚为旧的非空 schema；需要恢复内容时使用数据库备份。

## 回滚边界

- `007_process_run_admission` 只增加索引；停止新 API 并确认无新版本进程依赖后可以删除，但事故中保留索引更安全。
- `006_queue_recovery_audit` 的表可被旧版本忽略。停止 Recovery 后才能执行 down；保留审计通常优于删除。
- `005_retention_cleanup` 在任何 input/result 已清除后会拒绝 down。此时继续使用兼容代码，或从清理前备份恢复；不能伪造缺失内容。
- `004_webhook_endpoint_security` 在存在 Endpoint 时不允许降级。先停 Webhook Worker并保留加密数据，不能把信封当成明文 Secret。
- Redis Queue 可重建，PostgreSQL 不可用 Queue 反向重建。任何回滚都不得删除已接受 Run、owner、幂等键或未完成 Delivery。

发布证据至少保留：commit 与镜像摘要、migration 版本、配置非秘密摘要、备份 ID、五个角色 readiness、观测快照、人工全量 Recovery 报告、演练 Run/Event/Delivery ID、灰度时间线和回滚负责人。
