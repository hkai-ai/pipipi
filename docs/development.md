# 开发指南

本文面向修改 Business Processing Service 的开发者。它说明本地开发、代码结构、常见改动路径和完成标准；项目范围与术语以 [`../CONTEXT.md`](../CONTEXT.md) 为准，发布操作见 [`mvp-release-runbook.md`](mvp-release-runbook.md)。

## 开发前提

- Node.js 24 或更高版本；
- npm 与仓库中的 `package-lock.json`；
- Direct 路径可访问的 Business Capability；
- 仅在运行 Agent 或真实模型实验时需要模型凭证；
- 仅在运行 PostgreSQL/Redis 集成测试时需要 Docker Compose。

首次安装：

```bash
npm install
cp .env.example .env
```

`.env` 已被 Git 忽略。只在本地填写真实值，不要提交、粘贴到 issue，或写入测试夹具。CI 和可复现验证优先使用 `npm ci`。

## 本地开发

终端一启动仓库内的演示 Business Capability：

```bash
npm run dev:business-api
```

终端二启动服务并监听源码变化：

```bash
npm run dev
```

复制 `.env.example` 后，Direct 模式默认连接 `http://127.0.0.1:4000`，服务监听 `3000` 端口。用以下命令确认进程和一次完整执行：

```bash
curl --fail http://127.0.0.1:3000/healthz

curl --fail -X POST http://127.0.0.1:3000/execute \
  -H 'content-type: application/json' \
  -d '{
    "process": "content-processing",
    "version": "v1",
    "input": { "content": "  local   check  " }
  }'
```

`constructProcessingService` 是生产启动的唯一 Construction Seam。它在监听端口前完成配置解析、跨字段校验、Adapter 选择和 Application 组装。启动失败时先修正配置，不要把校验移到请求路径。

## 常用命令

| 命令 | 用途 | 是否访问外部系统 |
| --- | --- | --- |
| `npm run dev` | 监听源码并启动服务 | 运行请求时访问配置的 Business Capability |
| `npm run dev:api` | 与 `dev` 相同，显式启动 API 角色 | 运行请求时访问配置的 Business Capability |
| `npm run dev:dispatcher` | 启动 Outbox Dispatcher 与 Reconciler 角色 | 是，访问 PostgreSQL 与 Redis |
| `npm run dev:worker` | 启动 Process Worker 角色 | 是，访问 PostgreSQL、Redis 与业务依赖 |
| `npm run dev:webhook-worker` | 启动 Webhook Outbox 与 Delivery Worker 角色 | 是，访问 PostgreSQL、Redis 与已注册 Endpoint |
| `npm run dev:retention-cleaner` | 启动分批内容清理角色 | 是，会删除 PostgreSQL 中已到期内容 |
| `npm run dev:business-api` | 启动本地演示 Business Capability | 否 |
| `npm run check` | 只读运行 Biome 格式、lint 和 import 排序检查 | 否 |
| `npm run check:fix` | 写入 Biome 格式和安全修复 | 否；会修改工作区文件 |
| `npm run lint` | 只读运行 Biome lint | 否 |
| `npm run format` | 用 Biome 格式化受管文件 | 否；会修改工作区文件 |
| `npm run typecheck` | 严格 TypeScript 检查 | 否 |
| `npm test` | 运行确定性测试 | 否 |
| `npm run test:watch` | 监听并运行 Vitest | 否 |
| `npm run build` | 编译 `src/` 到 `dist/` | 否 |
| `npm run db:migrate` | 对 `DATABASE_URL` 执行受锁保护的 PostgreSQL migration | 是，会修改指定数据库 |
| `npm run recover:queue -- ...` | dry-run 或修复 PostgreSQL 与 Process Queue 的差异 | 是；`--apply` 会写 Queue、Outbox 与审计表 |
| `npm run observe:async` | 读取 PostgreSQL 与两个 BullMQ Queue，输出一次无内容运维快照 | 是，只读访问 PostgreSQL 与 Redis |
| `npm run test:integration:postgres` | 运行真实 PostgreSQL migration 与 Store contract tests | 是，会重建明确的 `_test` 数据库 schema |
| `npm run test:integration:async` | 运行真实 PostgreSQL、Redis、Outbox Dispatcher 与 BullMQ Worker 测试 | 是，会重建 `_test` schema 并清空指定 Redis 测试 DB |
| `npm run smoke:agent` | 验证真实 Agent 与 Business Capability | 是，可能产生模型费用 |
| `npm run smoke:staging` | 验证已部署的受控环境 | 是 |
| `npm run test:skill-ab` | 运行三组 Skill 对比 | 是，可能产生模型费用 |
| `npm run accept:poster-business`（`smoke:poster-process`、`test:gpt-image-2` 别名） | 从产品 `POST /execute` 验收 `minimal-zine-poster/v1`、真实图片与可选上传 | 是，可能产生模型和存储费用 |
| `npm run smoke:crt-gpt-image` | 验证一张本地参考图可通过 GPT Image 2 edit stage 生成 PNG；不运行 finalizer 或完整 Process | 是，读取本地图片、产生模型费用并写 `artifacts/` |
| `npm run accept:crt-business` | 从本地上传和产品 `POST /execute` 无 OSS 验收 `crt-interface-image/v1`、真实图片、finalizer 与可配置证据 | 是，读取本地图片、产生模型费用并写 `artifacts/` |
| `npm run smoke:oss` | 上传已有文件并读取首字节 | 是，会写对象存储 |

真实集成命令的配置、判据和产物见 [`experiments.md`](experiments.md)。默认测试套件不调用模型、OSS 或外部业务系统。

### PostgreSQL 集成测试

仓库提供只用于本地和 CI 的临时 PostgreSQL 17 配置。数据目录使用 `tmpfs`，测试会拒绝重建名称不以 `_test` 结尾的数据库：

```bash
docker compose -f compose.integration.yaml up -d --wait postgres
export POSTGRES_TEST_DATABASE_URL=postgres://pipipi:pipipi-test-only@127.0.0.1:55432/pipipi_test
npm run test:integration:postgres
docker compose -f compose.integration.yaml down
```

这两个 integration script 都会重建同一个 `_test` schema，Async suite 还会 `FLUSHDB`。使用同一组 URL 时必须串行运行；需要并行时为每个 suite 分配独立 PostgreSQL database 和非零 Redis database。

手动验证 migration 时显式把测试 URL 传给 `DATABASE_URL`：

```bash
DATABASE_URL="$POSTGRES_TEST_DATABASE_URL" npm run db:migrate
```

默认 `npm test` 不连接数据库；PostgreSQL 集成文件在缺少测试 URL 时跳过。生产 migration 必须由部署步骤使用最小权限凭证显式执行，应用启动不隐式修改 schema。

### PostgreSQL 与 Redis 异步集成测试

异步集成测试复用同一 Compose 文件，并只允许清空本机 Redis 的非零 database：

```bash
docker compose -f compose.integration.yaml up -d --wait
export POSTGRES_TEST_DATABASE_URL=postgres://pipipi:pipipi-test-only@127.0.0.1:55432/pipipi_test
export REDIS_TEST_URL=redis://127.0.0.1:56379/15
npm run test:integration:async
docker compose -f compose.integration.yaml down
```

测试证明 Outbox 在 PostgreSQL commit 后才进入统一 `process-runs` Queue，Job 只含 `schemaVersion` 和 `runId`，Worker 仍能从数据库选择准确 Registration。故障用例还覆盖 Dispatcher claim 过期、Redis 断线、重复 completed Job、Worker claim 过期接管、旧 token fencing 和停机超时 release。Compose Redis 使用 `noeviction` 和临时数据目录；它只用于测试，不代表生产高可用配置。

### 异步 HTTP 开发入口

异步路由默认关闭。启用时以下配置必须作为一个完整配置组提供：

- `ASYNC_PROCESS_RUNS_ENABLED=true` 与已完成 migration 的 `DATABASE_URL`；
- `ASYNC_RELEASE_STAGE=internal|canary|production`；
- 至少 32 bytes 的 `ASYNC_GATEWAY_SHARED_SECRET`；
- `PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS`、`PROCESS_RUN_RESULT_RETENTION_MS` 和 `PROCESS_RUN_METADATA_RETENTION_MS`；
- `ASYNC_GLOBAL_BACKLOG_LIMIT`、不高于它的 `ASYNC_CALLER_BACKLOG_LIMIT` 和 `ASYNC_BACKLOG_RETRY_AFTER_SECONDS`；
- 可选的 PostgreSQL Pool、连接超时、claim lease、轮询 `Retry-After` 与 staged readiness 阈值。

可信网关必须先验证 service principal，删除外部请求中的 `x-pipipi-caller-id` 和 `x-pipipi-gateway-token`，再分别注入稳定 subject 与共享凭证。应用不接受请求 body 中的 owner，也不把身份头、共享凭证或数据库错误写入响应。`GET /healthz` 始终只做 liveness；`GET /readyz` 在异步功能启用时检查包括 backlog admission 索引在内的数据库 migration，`canary` 与 `production` 还检查 backlog、stuck Run、已到期 Outbox lag 和最近一次从空 cursor 到最终空 `nextCursor` 的完整成功人工全量恢复链。

当前已验证提交、查询、Outbox 调度、BullMQ Worker、故障恢复、容量门禁、独立角色、结构化关联日志和运维快照。配置齐全不等于可以直接开放；外部生产流量必须按 [`async-process-runs-runbook.md`](async-process-runs-runbook.md) 完成安全审查、故障演练和 staged rollout。

### 异步运行角色

同一构建产物提供五个长运行命令：`npm run start:api`、`npm run start:dispatcher`、`npm run start:worker`、`npm run start:webhook-worker` 和 `npm run start:retention-cleaner`。五个角色应部署为独立进程或工作负载；API 不消费 Job，Dispatcher 不加载 Business Process 或 caller Secret，Process Worker 不加载网关身份配置，Webhook Worker 不加载 production catalog，Retention Cleaner 只连接 PostgreSQL。`npm run start:operations` 是读取 PostgreSQL 与两个 Queue 后退出的一次性运维 Job。启动后台命令本身就是启用该内部角色的部署选择；`ASYNC_PROCESS_RUNS_ENABLED` 只控制 API 是否公开异步路由。

| 配置 | API | Dispatcher | Process Worker | Webhook Worker | Retention Cleaner |
| --- | --- | --- | --- | --- | --- |
| `BUSINESS_API_BASE_URL` 与 Process 配置 | 必需 | 不读取 | 必需 | 不读取 | 不读取 |
| `ASYNC_PROCESS_RUNS_ENABLED` | 控制异步路由 | 不读取 | 不读取 | 不读取 | 不读取 |
| `ASYNC_RELEASE_STAGE`、`ASYNC_*_BACKLOG_*` 与 release thresholds | 异步路由启用时必需或采用安全默认值 | 不读取 | 不读取 | 不读取 | 不读取 |
| `ASYNC_GATEWAY_SHARED_SECRET` | 异步路由启用时必需 | 不读取 | 不读取 | 不读取 | 不读取 |
| `DATABASE_URL`、PostgreSQL Pool 配置 | 异步路由启用时必需 | 必需 | 必需 | 必需 | 必需 |
| 三个 `PROCESS_RUN_*_RETENTION_MS` | 异步路由启用时必需 | 不读取 | 必需 | 不读取 | 不读取；读取已持久化到期时间 |
| `REDIS_URL` | 不读取 | 必需 | 必需 | 必需 | 不读取 |
| `PROCESS_QUEUE_*` | 不读取 | 必需 | 必须与 Dispatcher 相同 | 不读取 | 不读取 |
| `WEBHOOK_QUEUE_*` | 不读取 | 不读取 | 不读取 | 可选覆盖 | 不读取 |
| `OUTBOX_*`、`PROCESS_RUN_RECONCILE_*` | 不读取 | 可选覆盖 | 不读取 | 不读取 | 不读取 |
| `PROCESS_WORKER_*` | 不读取 | 不读取 | 可选覆盖 | 不读取 | 不读取 |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | 不读取 | 不读取 | 不读取 | 必需，32-byte base64 key | 不读取 |
| Delivery retry 的 `WEBHOOK_*` | 不读取 | 不读取 | 不读取 | 可选覆盖 | 不读取 |
| `WEBHOOK_DELIVERY_HISTORY_RETENTION_MS`、`RETENTION_CLEANUP_*` | 不读取 | 不读取 | 不读取 | 不读取 | 可选覆盖 |
| `PORT`、`RUNTIME_ROLE_READINESS_TIMEOUT_MS` | `PORT` | 两者 | 两者 | 两者 | 两者 |

部署前先执行 migration。`PROCESS_RUN_CLAIM_LEASE_MS` 必须大于 `PROCESS_TIMEOUT_MS`，避免正常 Attempt 在超时治理结束前被接管。每个环境使用独立 `PROCESS_QUEUE_PREFIX`；调用方不能提交 queue name、concurrency、retry 或 Redis 配置。

`content-processing/v1` 默认 `CONTENT_PROCESSING_RETRY_MAX_ATTEMPTS=1`。只有确认下游按 `Idempotency-Key: <runId>` 去重后，才可把该值提高到 `2`–`5`；当前只把稳定的 `DEPENDENCY_FAILURE` 分类为可重试。`CONTENT_PROCESSING_RETRY_INITIAL_DELAY_MS` 和 `CONTENT_PROCESSING_RETRY_MAX_DELAY_MS` 控制指数退避，最大延迟不超过 300 秒。等待重试时公开状态仍是 `queued`，请求 body 不能覆盖这些策略。

五个角色都提供 `GET /healthz` 和 `GET /readyz`。liveness 只确认进程工作，不访问下游；readiness 检查该角色实际使用的 migration、PostgreSQL 和 Redis，并在有界时间内返回 `503`，不暴露连接地址或内部错误。默认同步 API 保持原样，启用异步路由也不会删除 `POST /execute`。

### Queue 对账与重建

Dispatcher 的周期 `reconcileOnce()` 与人工 `recover:queue` 共用同一个 Process Recovery Module。`stale` 模式只检查超过 `PROCESS_RUN_RECONCILE_QUEUED_AGE_MS` 的 queued Run 和租约过期的 running Run；`all` 模式扫描所有非终态 Run，适合 Redis 数据丢失后的完整重建。终态 Run 从 PostgreSQL 候选 SQL 中排除，即使 Redis 残留旧 Job，Worker 的数据库 claim 也会将其短路为 ignored。活跃 running 租约在 `all` 报告中标为 `active_lease/deferred`，不提前抢占；到期后的下一次恢复会重新入队，旧 Worker 仍受 claim token fencing 约束。

人工命令默认 dry-run，必须提供可审计 operator 身份：

> 警告：dry-run 会写恢复审计；`--apply` 还会写 BullMQ 并确认 Process Outbox。只对逐字核对过的测试、staging 或事故目标执行，生产操作以 [`async-process-runs-runbook.md`](async-process-runs-runbook.md) 的授权和安全动作要求为准。

```bash
PROCESS_RECOVERY_ACTOR_ID=operator:alice npm run recover:queue -- --mode=all
PROCESS_RECOVERY_ACTOR_ID=operator:alice npm run recover:queue -- --apply --mode=all
```

dry-run 只检查 PostgreSQL 与 Redis 并写恢复审计，不写 Queue 或 Outbox。`--apply` 对 `missing` 或只有 terminal BullMQ Job 的非终态 Run，以稳定 `runId` 重新 `queue.add()`；并发恢复最多得到 `duplicate`，不会产生第二个有效 Job。只有确认 Job 已存在或成功入队后，才把对应 pending Process Outbox 标记为已对账。每批最多使用 `PROCESS_RUN_RECONCILE_BATCH_SIZE`，固定同一个 `asOf` 并自动沿 `nextCursor` 继续；`--single-batch` 可停在一个批次，随后用日志或 `queue_recovery_runs.next_cursor_run_id` 配合原 `--as-of`、`--cursor` 续跑。

每次有候选的 periodic 恢复和每次 manual dry-run/apply 都写 `queue_recovery_runs`，每个候选再写不含业务内容的 `queue_recovery_items`；无候选 periodic 只返回零计数，避免审计表按轮询频率无界增长。完成记录包含 missing/existing/terminal/invalid Job、active lease、pending Outbox、enqueue、duplicate、ack 和 failure 计数。中途崩溃会留下 `running` 审计行；重跑是幂等的，并会把已成功入队的 Job 识别为 existing。若某一候选 Redis 操作失败，同批其他候选继续，命令以非零状态结束。不要直接从 Queue 反推产品状态，也不要用 `FLUSHDB` 作为常规运维手段。

### 运维快照与容量门禁

`npm run observe:async` 一次性读取 PostgreSQL 权威状态与两个 BullMQ Queue，输出 `async_operations_snapshot` JSON。它覆盖 queued/running、近期 queue wait/execution p95、failure rate、stuck、已到期 Process/Webhook Outbox lag、Delivery failure、cleanup/recovery 和完整异步表 storage，并给出两个 Queue 的 waiting/active/delayed/failed 与跨状态最老 runnable age。生产镜像使用 `npm run start:operations`；由受信定时 Job 采集，不增加产品 HTTP 路由。Dashboard 与告警字段以 [`../ops/async-observability.json`](../ops/async-observability.json) 为准。

PostgreSQL Store 在 acceptance 事务内先检查 caller-scoped idempotency，再使用事务级 advisory lock 串行统计非终态 backlog。caller 达到阈值抛出稳定 `429 CALLER_BACKLOG_LIMIT_REACHED`，全局达到阈值抛出 `503 ASYNC_SERVICE_CAPACITY_REACHED`，都返回配置的 `Retry-After`；相同请求的幂等重放和既有 Run GET 不受门禁影响。`007_process_run_admission` 的 caller/status 部分索引保持检查可预测。

成功日志只保留关联元数据：API/Worker 用 `runId`，Outbox 用 `messageId + eventId + runId|deliveryId`，Webhook Attempt 用 `deliveryId + eventId`。日志不得包含 idempotency key、accepted input、output、Webhook URL/payload、Secret 或内部异常正文。精确部署、告警处置和 fault drill 见 [`async-process-runs-runbook.md`](async-process-runs-runbook.md)。

### 内容保留与清理

模板采用以下安全起点：accepted input 1 天、成功 output 或稳定 error 7 天、Run metadata 30 天、已完成 Webhook Delivery Attempt 历史 30 天。前三项通过 `PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS`、`PROCESS_RUN_RESULT_RETENTION_MS` 和 `PROCESS_RUN_METADATA_RETENTION_MS` 显式配置，并在接受或完成 Run 时写成绝对到期时间；Delivery 历史通过 `WEBHOOK_DELIVERY_HISTORY_RETENTION_MS` 配置，未填写时 Retention Cleaner 使用 30 天。缩短内容期限可降低隐私暴露和数据库体积，但必须覆盖调用方正常轮询、故障恢复和争议处理窗口；延长期限前应完成数据授权、容量与删除 SLA 评审。

`npm run start:retention-cleaner` 每小时默认启动一次 sweep，每批最多 25 个 Run、每个 sweep 最多 100 批；分别用 `RETENTION_CLEANUP_INTERVAL_MS`、`RETENTION_CLEANUP_BATCH_SIZE` 和 `RETENTION_CLEANUP_MAX_BATCHES_PER_SWEEP` 调整。每个 sweep 固定一个 `asOf`，每批独立事务并写 `retention_cleanup_batches` 计数、输入游标和下一游标。收到关闭信号时，角色等待当前批次提交或回滚，再停止下一批；人工调用 `RetentionCleaner.runSweep({ asOf, cursor, signal })` 可用返回的 `nextCursor` 继续同一 cutoff。失败批次整体回滚，重复同一范围是幂等的。

清理器绝不删除 queued/running Run 的 accepted input。终态 input 到期后只移除输入；结果到期后保留 `status`、`startedAt` 和 `finishedAt`，查询返回 `resultAvailability: "expired"` 与 `resultExpiredAt`。Run metadata 只有在 input/result 均到期、Webhook outbox 不再待发布，而且关联 Delivery 已终态并超过 Delivery 历史期限后才删除；删除 Run 时由外键一起删除 Attempt、Event、已发布 Outbox、Delivery 和 caller-scoped 幂等记录，不留下悬空引用。因此 metadata 的实际保留时间可能长于配置下限。`005_retention_cleanup` 的回滚会在已经清除内容时拒绝执行；此时应从备份恢复内容或继续使用新 schema，不能把缺失内容伪装成旧版非空字段。

Webhook Endpoint 由运维侧预注册并绑定 caller；Process 提交不能携带 callback URL。Webhook Worker 只发送包含 `eventId`、`runId`、准确 Process/version、终态、完成时间和相对查询位置的 payload，不复制输入、输出或内部错误。Endpoint 注册、URL 修改、Secret 轮换、停用和审计目前是受信运维代码调用的内部 Store Interface，不是产品请求路由；调用方身份必须先由控制面认证，再作为 `ownerId` 与 `actorId` 传入。

`WEBHOOK_SECRET_ENCRYPTION_KEY` 是每环境独立的 32-byte base64 key，只注入 Webhook Worker。签名 Secret 以绑定 Endpoint ID 的 AES-256-GCM 信封保存；查询不会返回明文或信封。`rotateEndpointSecret` 将旧 Secret 保留在最长 7 天的明确 overlap 窗口内，Worker 在窗口内生成两个签名，窗口外只解密 current Secret。migration `004_webhook_endpoint_security` 为避免把历史明文误标成密文，只允许在尚未配置 Endpoint 时迁移或回滚；已有测试 Endpoint 必须先清空并在迁移后重新配置。

正常环境只接受 HTTPS。注册和每次投递都解析全部目标地址，拒绝 loopback、link-local、RFC1918、云 metadata、保留、转换和其他非公网范围；投递连接通过自定义 DNS lookup 固定到本次已验证 IP，Node HTTP client 不跟随重定向。DNS 解析失败按瞬时网络错误重试；解析到不安全地址则以稳定原因失败、停用该 Endpoint 并写审计。`WEBHOOK_ALLOW_INSECURE_HTTP=true` 与 `WEBHOOK_TEST_ALLOW_UNSAFE_TARGETS=true` 都只能在 `NODE_ENV=test` 的隔离测试进程使用。

Webhook 重试状态以 PostgreSQL 为准，不依赖 BullMQ 的 Job attempts。网络错误、`429` 和 `5xx` 在 `WEBHOOK_DELIVERY_HORIZON_MS` 内按有界指数退避重试；`WEBHOOK_DELIVERY_MAX_RETRY_AFTER_MS` 限制远端 `Retry-After`，`WEBHOOK_DELIVERY_JITTER_PERCENT` 防止同步重试。默认最多 8 次 Attempt、初始等待 5 秒、单次最长等待 1 天、总投递期限 3 天。永久 `4xx` 直接失败，`410` 只停用返回该状态的 Endpoint。

每次 claim 会先创建 `started` Attempt，完成后只保存响应分类、HTTP 状态、延迟和稳定错误码，不读取或保存远端正文。运维查询必须携带 owner，并可从 run、event 或 endpoint 找到 Delivery，再查询其 Attempt。只有 `failed` 或 `exhausted` Delivery 可通过 `PostgresWebhookDeliveryStore.replay` 人工重放；调用方传入经过认证的 owner 与 operator actor。重放创建新 Delivery 和独立 Attempt 链，保留原记录与审计事件，并复用原 `eventId` 供接收方去重。

## 代码地图

`src/` 按拥有行为的 Module 分组。目录表达代码所有权；Adapter 与其实现的 Interface 保持在同一 Module 内。

| 目录 | Module 职责 |
| --- | --- |
| `src/bin/` | API、Dispatcher、Worker、Cleaner、Operations 和 Recovery 的可执行入口；不放业务规则 |
| `src/app/` | 各可执行角色的 Composition Root、启动配置和后台角色生命周期 |
| `src/api/` | HTTP Application、路由和 caller identity；不组装业务与基础设施 |
| `src/processes/` | Process Runtime、共享 Agent 基础设施、production catalog，以及按 `content/`、`titled-content/`、`poster/`、`crt/` 分组的具体 Business Process |
| `src/process-runs/` | Async Process Runs，以及按 `store/`、`queue/`、`outbox/`、`worker/`、`recovery/`、`retention/` 和 `ops/` 分组的内部 Module |
| `src/webhooks/` | Webhook Delivery，以及按 `delivery/`、`store/`、`queue/`、`outbox/` 分组的内部 Module |
| `examples/support/` | 只供真实集成与业务验收使用的 OpenAI Images 和对象存储 Adapter；不进入生产 `dist/` |
| `migrations/` | 受版本和 advisory lock 管理的 PostgreSQL schema 变化 |
| `test/` | 跨公开 Seam 的确定性行为验证 |
| `examples/` | 本地依赖、真实集成、业务验收和可复现实验 |

关键 Interface 和 Composition Root 位于：

| 路径 | 职责 |
| --- | --- |
| `src/app/api.ts` | API 配置翻译、校验、Adapter 选择和完整生产组装 |
| `src/app/business-processes.ts` | production Business Process Runtime 与 catalog 依赖组装 |
| `src/app/process-dispatcher.ts`、`process-worker.ts`、`retention-cleaner.ts` | 各后台角色独立的配置和 Adapter 组装 |
| `src/app/process-recovery.ts`、`async-operations.ts` | 一次性运维命令的资源组装 |
| `src/app/webhook-worker.ts` | Webhook Worker 的 Delivery、Outbox、Queue 和 HTTP Sender 组装 |
| `src/processes/runtime/` | Registration、Registry、同步 Runner、Attempt Runner、Run Record、公共结果和错误治理 |
| `src/processes/agent/pi.ts`、`skills.ts` | 多个流程共用的 Pi provider 配置、Agent JSON 解析和 Runtime Skill 精确加载 |
| `src/processes/catalog.ts` | 显式 production catalog 和 Process Runtime 组装 |
| `src/processes/content/registration.ts` | `content-processing/v1` 的 Schema、Direct/Agent 流程、失败和 Tool 调用 invariant |
| `src/processes/content/skills.ts` | `content-processing/v1` 获准使用的有序 Runtime Skill 集合与 Tool 名称 |
| `src/processes/content/agent.ts`、`pi.ts` | 窄 Content Agent Interface，以及生产 Pi Adapter |
| `src/processes/poster/registration.ts` | `minimal-zine-poster/v1` 的 Schema、Prompt 校验、执行顺序和稳定失败 |
| `src/processes/poster/agent.ts`、`pi.ts` | 无 Tool 的 Poster Agent Interface 与 Pi Prompt 编译 Adapter |
| `src/processes/poster/capability.ts`、`http.ts` | Poster Rendering Capability、图片引用契约与生产 HTTP Adapter |
| `src/processes/poster/skills.ts` | `minimal-zine-poster/v1` 绑定的准确 Runtime Skill |
| `src/processes/crt/registration.ts` | `crt-interface-image/v1` 的上传资产引用、Prompt/recipe 校验、顺序和稳定失败 |
| `src/processes/crt/agent.ts`、`pi.ts` | 看不到参考图和资产标识的无 Tool CRT Agent Interface 与 Pi Adapter |
| `src/processes/crt/capability.ts`、`http.ts` | CRT Rendering Capability、PNG 引用契约与 `POST /crt-images` Adapter |
| `src/processes/crt/style.ts`、`skills.ts` | 固定调色板、画幅和准确 Runtime Skill 绑定 |
| `src/process-runs/index.ts` | 异步提交、owner 隔离、caller-scoped idempotency 和公共状态投影 |
| `src/process-runs/store/index.ts`、`src/process-runs/store/postgres.ts` | 权威状态转换，以及内存和 PostgreSQL Adapter |
| `src/process-runs/queue/index.ts`、`src/process-runs/queue/bullmq.ts` | 最小 Job Interface，以及内存和 BullMQ Adapter |
| `src/process-runs/recovery/index.ts`、`src/process-runs/recovery/postgres.ts` | 周期 reconciliation、人工 Queue Recovery，以及恢复候选的 PostgreSQL Adapter |
| `src/process-runs/ops/postgres.ts` | 异步运维快照和 staged release readiness 的 PostgreSQL Adapter |
| `src/webhooks/delivery/` | Delivery Worker、HTTP Adapter、Standard Webhooks 签名和目标策略 |
| `src/webhooks/store/postgres.ts` | Endpoint、Delivery、Attempt 和 replay 的 PostgreSQL Adapter |
| `src/webhooks/queue/`、`src/webhooks/outbox/` | Webhook Job 调度和事务 Outbox 发布 |

依赖方向固定为 `bin → app → api/processes/process-runs/webhooks`。领域与业务 Module 不反向引用
`app/` 或 `bin/`；Composition Root 负责把它们连接起来。

顶层目录使用明确的领域名，子目录对应实际 Module。父目录已经提供的上下文不在文件名中重复，例如使用 `src/process-runs/store/postgres.ts`，不用 `src/process-runs/store/postgres-process-run-store.ts`；Adapter 文件只保留 `postgres.ts`、`bullmq.ts`、`http.ts` 等技术名称。不要新增 `common/`、`shared/`、`utils/` 或横向的 `controllers/services/repositories` 目录。无法明确归属的代码应先重新检查 Module 和 Seam。

完整 Module 关系见 [`process-runtime-design.md`](process-runtime-design.md)。海报与 CRT Business Process 及其受控 HTTP Adapter 已进入 production catalog；供应商专用的 OpenAI Images 与阿里云 OSS Adapter 仍只由 `examples/` 中的显式集成和业务验收使用。各 Process 的独立入口见 [`processes/`](processes/)；CRT 的上传、后处理和完整发布门禁见 [`processes/crt-interface-image/`](processes/crt-interface-image/)。

## 命名规则

名称应在使用点直接表达角色，并尽可能短。不要把目录、类型和调用链重复拼进同一个标识符。新代码和本次触达的旧代码遵守以下规则；其他旧名在相关 Module 发生修改时逐步整理。

### 利用作用域

- 目录和文件已经表达的领域不在私有名称中重复。`content/registration.ts` 使用 `RegistrationOptions`，不用 `ContentProcessingRegistrationOptions`。
- 跨 Module 导出保留“必要领域词 + 角色”。例如 `PiContentAgent` 同时说明 Adapter 和角色；`Agent` 太宽，`PiContentOptimizationAgentRuntime` 重复过多。
- 同一文件内优先使用 `mode`、`config`、`inputMaxBytes` 等短名。出现导入冲突时在导入处使用别名，不给所有声明添加前缀。
- 集合使用复数名，布尔值使用 `is`、`has`、`can` 或 `should` 前缀。名称必须描述值，不描述它的历史来源。

### 使用准确动词

| 动词 | 用途 |
| --- | --- |
| `create` | 在内存中创建并返回 Module、Adapter 或值 |
| `load` | 从文件、环境或远端读取数据 |
| `parse` | 校验并转换外部表示，失败时抛出明确错误 |
| `find` | 查询可能不存在的值 |
| `require` | 查询必需值，缺失时失败 |
| `run`、`execute` | 执行业务或运行时行为 |

避免用 `construct`、`handle`、`manage`、`do` 或 `process` 掩盖更具体的动作；领域本身把 `process` 定义为动作时可以保留。Factory 统一使用 `create`，不要只靠 `build`、`make`、`construct` 的细微差别区分相邻函数。

### 控制长度

- 私有或局部名称超过 24 个字符、导出名称超过 32 个字符时必须复核。这个长度是评审触发线，不是硬限制。
- 删除不能帮助当前调用点区分含义的词。若删除后产生歧义，优先调整 Module 或导入别名，再考虑增加限定词。
- 可以使用行业通用缩写：`id`、`url`、`http`、`api`、`json`、`sql`、`db`、`ms`。禁止使用 `mgr`、`cfg`、`proc` 等需要猜测的自造缩写。
- `Options`、`Config`、`Result`、`Adapter` 等后缀只有在表达真实角色时保留。文件内只使用一次的参数类型可以保持私有并命名为 `Options` 或 `RegistrationOptions`。

本次整理提供以下基准：

| 原名称 | 新名称 | 理由 |
| --- | --- | --- |
| `PiContentOptimizationAgentRuntime` | `PiContentAgent` | 所属 Module 与 Pi Adapter 已表达 Runtime 上下文 |
| `constructBusinessProcessRuntime` | `createProductionRuntime` | 直接说明它创建生产 Runtime |
| `createBusinessProcessRuntime` | `createProcessRuntime` | `Process` 已是仓库共同语言 |
| `createContentProcessingRegistration` | `createContentRegistration` | 返回角色保留，目录上下文删除 |
| `acceptedProcessInputPayloadMaxBytes` | `inputMaxBytes` | 私有常量无需重复 Registration 上下文 |

## 设计改动的工作方式

修改代码前先回答四个问题：

1. 哪些调用方需要这项行为？
2. 调用方必须知道哪些 Interface 事实？
3. 现有 Seam 能否隐藏新复杂度？
4. 哪些测试可以只通过该 Interface 证明行为？

优先加深现有 Module：减少调用方必须学习的方法、参数和顺序约束，把变化集中的规则留在 Implementation 内。设想删除该 Module；如果复杂度会重新散落到多个调用方，它提供了 Leverage 和 Locality。若复杂度直接消失，它可能只是浅层转发。

依赖由调用方注入，结果通过返回值表达。只有存在真实替换需求时才增加 Seam；生产 Adapter、受控测试 Adapter 或第二个供应商 Adapter 应共享同一个窄 Interface。不要为假想扩展点提前建立通用 Capability bag。

Interface 是测试面。测试应覆盖公开结果、invariant、错误和副作用，不读取私有 Map，不断言内部 helper 顺序，也不因等价 Implementation 重构而重写。

Process Registration 的 `accept` 解析外部输入一次，返回绑定准确 Process/version 的不可变
JSON-safe snapshot。业务 input payload 默认上限为 262144 UTF-8 bytes，序列化 Process identity
上限为 4096 bytes，完整 snapshot 上限为 266267 bytes。`run` 只执行 accepted input，不重新运行
输入 Schema；成功 output 同样必须是最大 262144 UTF-8 bytes 的 JSON-safe snapshot。同步 Process Runner 连续调用两步；需要延迟执行的内部调用方把 accepted input
持久化后，通过 Process Attempt Runner 传入预先分配的 `runId`。产品调用方不能直接提交或
修改 accepted input。

## 新增 Business Process

流程拓扑和业务语义保留在 TypeScript 中，不使用 JSON 工作流语言。维护者可以把自然语言需求直接交给 Codex；需求输入、判断规则和完整完成标准见 [`authoring-business-processes.md`](authoring-business-processes.md)。

1. 新建 `create…Registration` factory，通过 `defineProcessRegistration` 声明固定 `id`、`version`、输入 Schema、输出 Schema 和 Process Definition。
2. 把该流程获准使用的窄 Business Capability 和稳定策略传给 factory，并由闭包捕获。流程使用 Agent 时，在流程 Module 内定义准确、有序的 Skill 与 Tool 集合；Composition Root 只提供 Adapter 和部署配置。Execution Context 只携带 `runId` 和 `AbortSignal` 等请求级信息。
3. 用 `failProcess` 返回预期的 `AGENT_FAILURE` 或 `DEPENDENCY_FAILURE`。让意外异常继续抛出，由 Process Runner 转换为安全的 `INTERNAL_ERROR`。
4. 在 `createProcessExecutor` 的显式 production catalog 中加入 Registration。每项只代表一个准确 `(id, version)`。
5. 通过 Registration Seam 测试接受、JSON 往返、单次解析、策略和输出。Agent 流程还要验证 Tool 调用次数、下游幂等键和最终结果来源；通过 Process Attempt Runner 测试预分配 `runId`、超时与错误净化；通过真实本地 `/execute` 测试产品行为和 HTTP 映射。
6. 创建或更新 `docs/processes/<process-id>/README.md`，再更新 README 的当前能力、`CONTEXT.md` 的产品契约，以及受影响的设计或发布文档。目录和内容规则见 [Business Process 文档目录](processes/README.md)。

[`src/processes/titled-content/registration.ts`](../src/processes/titled-content/registration.ts) 是最小示例；[`src/processes/poster/registration.ts`](../src/processes/poster/registration.ts) 展示 Agent 编译后再调用 Business Capability 的两阶段流程；[`src/processes/crt/registration.ts`](../src/processes/crt/registration.ts) 展示如何把预上传资产保持为不透明业务字段。新版本必须新建 Registration 并显式加入 catalog；不要加入 `latest`、默认版本、自动发现或回退。

流程需要外部 Skill 时，先按 [`integrating-runtime-skills.md`](integrating-runtime-skills.md) 在开发期解析、审查和固定来源。Process Registration 可以绑定一个或多个随应用发布的本地 Runtime Skill；完整集合必须一起评审。产品请求不接收 Skill 名称、路径或 URL。

## 修改外部依赖

远程协议、供应商 SDK、认证、重试和响应解析属于 Adapter 的 Implementation。Process Definition 只依赖窄 Business Capability Interface，并只看领域结果或净化后的依赖错误。

新增或更换 Adapter 时：

1. 先保持现有 Interface，确认新需求确实属于同一业务能力。
2. 在 Adapter 内完成超时、取消、响应 Schema 和供应商错误转换。
3. 用受控本地 server 或 fake Adapter 验证，不在默认测试中访问真实远端。
4. 只在 Startup Construction 或明确的 composition root 选择生产 Adapter。
5. 若新供应商迫使调用方理解其专有概念，重新检查 Seam 是否放错位置。

## 接入 Run Record

默认生产构造使用 disabled 实现，只输出结构化完成日志。开发或单实例测试可以注入有容量上限的内存实现：

```ts
import { createProcessingApplication } from "./src/api/application.js";
import { createProcessExecutor } from "./src/processes/catalog.js";
import { createInMemoryProcessRunRecords } from "./src/processes/runtime/records.js";

const runRecords = createInMemoryProcessRunRecords({ maxRecords: 100 });
const executor = createProcessExecutor({
  contentProcessing,
  runRecords,
});
const application = createProcessingApplication({ executor });

const record = await runRecords.find(runId);
```

内存记录按写入顺序淘汰，进程重启后丢失，也不在实例间共享。生产持久化应实现 `ProcessRunRecordAdapter`，再通过 `createProcessRunRecords({ adapter })` 接入数据库或可观测平台；Adapter 写入失败不能改变 Process Run 结果。

默认内容策略为 `omit`。只有完成数据授权、租户隔离、脱敏和保留期限评审后，才设置 `content: "accepted-input-and-output"`。该策略只接收已被 Registration 接受的输入和成功输出，不保存无效请求、Prompt、Tool 过程、模型消息或隐藏推理。

Run Record 是运行排障数据，不是聊天历史。产品聊天记录应由业务数据库按用户与会话保存，并把 `runId` 作为关联键。若要公开 Run Record 查询，先设计调用方认证、租户隔离和内容访问策略。

## 配置规则

[`.env.example`](../.env.example) 是配置键的可复制清单；解析函数和测试约束精确默认值与组合规则。

- 新增配置时同时更新 `.env.example`、启动构造测试和相关文档。
- 只把稳定运行策略放入环境配置。Process 拓扑、Schema 和业务语义留在代码中。
- 成组配置在启动时一起校验。例如 `PI_PROVIDER` 与 `PI_MODEL` 必须同时设置。
- 异步功能关闭时忽略数据库和网关专用配置；启用后缺少任一必需值都在监听前失败。
- `CONTENT_PROCESSING_MODE=direct` 只关闭文本 Agent；`minimal-zine-poster/v1` 与 `crt-interface-image/v1` 始终使用 Agent，因此共享的 Pi provider、model 和 API mode 仍须有效。
- `POSTER_API_TIMEOUT_MS` 只控制受控 `POST /posters` Adapter，默认 `90000`；Process 总超时仍由 `PROCESS_TIMEOUT_MS` 治理。
- `CRT_API_TIMEOUT_MS` 只控制受控 `POST /crt-images` Adapter，默认 `180000`。受控发布必须让 `PROCESS_TIMEOUT_MS` 长于它，平台请求超时再长于 Process 总超时。
- `IMAGE_PROVIDER=openai|fal` 选择真实图片集成 Adapter，默认 `openai`。OpenAI Adapter 可用 `OPENAI_IMAGE_API_KEY` 与 `OPENAI_IMAGE_BASE_URL` 脱离 Agent 网关；未设置时回退到 `OPENAI_API_KEY` 与 `OPENAI_BASE_URL`。FAL Adapter 只读取服务端 `FAL_KEY`，并固定调用 GPT Image 2 生成与编辑 endpoint。
- `CRT_IMAGE_EVIDENCE_MODE=off|metadata|full` 控制 `crt-interface-image/v1` 的服务端证据副本。产品请求不能覆盖它；本地完整验收默认 `full`，生产 `POST /crt-images` 必须默认 `off`。
- `CRT_IMAGE_EVIDENCE_DIRECTORY` 只在 `metadata` 或 `full` 时使用。完整字段、敏感数据边界和清理责任见 [`crt-interface-image` 的证据保留说明](processes/crt-interface-image/evidence-retention.md)。
- `PI_SKILL_DIRECTORY`、`PI_POSTER_SKILL_DIRECTORY` 与 `PI_CRT_SKILL_DIRECTORY` 分别覆盖一个固定绑定，不改变 Skill 名称、集合或顺序。
- `.env.example` 把 `PROCESS_TIMEOUT_MS` 设为 `240000`，用于同时容纳 CRT edit 和 finalizer 的受控发布形状；未设置变量时，代码默认值仍为 `30000`。
- Secret 只由本地 `.env` 或部署平台注入。日志和错误响应不得包含凭证、Base URL、远端正文或模型错误。

## 测试策略

按风险从窄到宽验证：

1. 在改动附近运行单个测试文件，例如 `npm test -- test/process-runtime.test.ts`。
2. 运行 `npm run check`、`npm run typecheck` 和 `npm test`。
3. 修改构建、入口或发布资源时运行 `npm run build`；修改镜像时再构建 Docker image。
4. 只有确定性验证通过后，才运行需要凭证、网络或费用的 smoke。

测试职责保持清晰：

- Startup Construction 测试配置解析、跨字段拒绝和完整生产组装。
- Process Runtime 测试 Registration、Registry、Process Attempt Runner 和同步 Runner 的 Interface invariant。
- HTTP Adapter 测试传输错误、容量、状态码和结构化日志。
- Application 测试 server 生命周期，不了解具体 Business Process。
- Process Registration 测试流程 Schema、获准依赖、策略和错误契约。
- Adapter 测试协议与错误转换；默认使用本地受控依赖。

修复缺陷时先增加能跨正确 Seam 复现问题的测试。若只能穿透 Interface 才能验证，先重新检查 Module 形状。

## 完成标准

一项开发改动完成时应满足：

- Interface 比改动前更清楚，或至少没有把 Implementation 知识推给调用方；
- 预期失败有稳定错误码，意外失败不会泄露内部消息；
- 确定性测试覆盖成功、拒绝和关键 invariant；
- `npm run check`、`npm run typecheck`、`npm test` 和受影响的构建检查通过；
- 配置样例、项目说明、设计文档和 Runbook 与代码保持一致；
- 不含 `.env`、真实业务内容、签名 URL、模型过程或其他敏感产物。
