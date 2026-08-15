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

`ASYNC_PROCESS_RUNS_ENABLED` 默认是 `false`。设置为 `true` 还必须给出 `ASYNC_RELEASE_STAGE=internal|canary|production`、持久化期限、网关 Secret 和 backlog admission 上限。`internal` 只允许私网测试流量；`canary` 与 `production` 的 API readiness 会额外执行容量、stuck Run、已到期 Outbox 延迟和最近人工全量恢复门禁。未来才到 `availableAt` 的延迟 Webhook 重试不计入当前 Outbox backlog 或 lag。

## 发布前置条件

候选提交必须先通过确定性与真实依赖验证：

> 警告：`npm ci` 会访问配置的软件包源并重建 `node_modules`；只在隔离的候选工作区运行。以下集成测试还会重建名称以 `_test` 结尾的 PostgreSQL schema，并清空明确的本机非零 Redis database；执行前逐字核对两个测试 URL，禁止传入共享或生产地址。

```bash
npm ci
npm run check
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

发布人员还必须确认：

- PostgreSQL 已完成备份与恢复验证，Redis 使用内部网络、认证、`noeviction` 和批准的高可用形状；
- 网关删除外部同名身份头，再注入 `x-pipipi-caller-id` 与 `x-pipipi-gateway-token`；容器端口不能绕过网关访问；
- `CONSOLE_DEVELOPMENT_GATEWAY_ENABLED` 必须在生产保持未设置或 `false`；Vite 开发 Gateway 固定测试身份且只允许 loopback upstream，不能承担生产调用方认证；
- `WEBHOOK_SECRET_ENCRYPTION_KEY`、网关 Secret 和数据库/Redis 凭证通过 Secret 管理器注入，彼此最小授权；
- Business Capability 已按 `runId` 支持幂等后，才能把 Registration 的最大 Attempt 从 1 提高；
- 观测系统已经导入 [`ops/async-observability.json`](../ops/async-observability.json)，并能按 `runId`、`eventId` 和 `deliveryId` 检索单行 JSON 日志；
- 已批准 accepted input、result、metadata 和 Delivery history 的期限与数据库容量预算。

## 受控 internal 发布入口

`.github/workflows/async-internal-release.yml` 是唯一自动化异步启用入口。它只响应手动 `workflow_dispatch`，整个 Job 绑定 GitHub `async-internal` Environment。它与默认同步发布共享不可取消的 `pipipi-production-release` 并发组，并在服务器用同一个 `shared/deployment.lock` 做第二层互斥；同步与异步发布不能同时修改 `pipipi` Compose project、共享文件或 PostgreSQL schema。仓库管理员必须为该 Environment 配置 required reviewers 和只允许受保护分支；普通 `push`、Pull Request 与默认 `Production CI/CD` 都不能触发它。

Environment 只保存部署连接和非秘密 Queue identity，不保存应用运行凭证：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Secret | `SSH_PRIVATE_KEY` | 连接单服务器部署账户的私钥 |
| Secret | `SSH_KNOWN_HOSTS` | 通过独立可信渠道核对并固定的目标服务器 host key；不得在发布时用 `ssh-keyscan` 临时信任 |
| Secret | `ASYNC_INTERNAL_CALLER_A_AUTHORIZATION`、`ASYNC_INTERNAL_CALLER_B_AUTHORIZATION` | 两个不同、已认证 internal 操作者的网关凭证 |
| Secret | `ASYNC_INTERNAL_SUCCESS_REQUEST`、`ASYNC_INTERNAL_FAILURE_REQUEST` | 受控成功请求与会稳定到达公开业务失败终态的请求 JSON；workflow 不输出或保存正文 |
| Secret | `ASYNC_DATABASE_URL` | 可选的数据库覆盖值；未配置时从服务器受保护的 `shared/.env` 复用 `DATABASE_URL`。最终连接必须带用户名、密码、`uselibpqcompat=true`、`sslmode=verify-ca` 和容器内固定 CA 路径 `/etc/pipipi/pg-server.crt`，且在写入角色文件前通过只读生产数据库边界审计 |
| Secret | `ASYNC_REDIS_URL` | 可选的 Redis 覆盖值；未配置时从服务器受保护的 `shared/.env` 复用唯一的 `REDIS_URL`。最终连接必须使用带密码的 `rediss://`，不能指向基础 Compose 临时创建的 Redis |
| Variable | `REMOTE_HOST`、`REMOTE_USER`、`REMOTE_PATH` | 与同步发布相同的服务器地址、账户和绝对应用目录 |
| Variable | `ASYNC_INTERNAL_GATEWAY_BASE_URL` | 真实可信网关的 HTTPS Base URL |
| Variable | `PROCESS_QUEUE_NAME`、`PROCESS_QUEUE_PREFIX` | internal Process Queue identity；已有异步形状不允许发布时改变 |
| Variable | `WEBHOOK_QUEUE_NAME`、`WEBHOOK_QUEUE_PREFIX` | internal Webhook Queue identity；已有异步形状不允许发布时改变 |

服务器必须预先存在数据库证书、默认 Business API Secret 和五份最小角色 Secret：

```text
<REMOTE_PATH>/shared/.env
<REMOTE_PATH>/shared/pg-server.crt
<REMOTE_PATH>/shared/async-api.env
<REMOTE_PATH>/shared/process-dispatcher.env
<REMOTE_PATH>/shared/process-worker.env
<REMOTE_PATH>/shared/webhook-worker.env
<REMOTE_PATH>/shared/retention-cleaner.env
```

每份角色文件只包含[配置表](#配置与分阶段启用)中该角色拥有的值；Queue name/prefix 与 `ASYNC_RELEASE_STAGE` 由发布入口覆盖，不放在 Secret 文件里。API 文件必须包含 `ASYNC_GATEWAY_SHARED_SECRET`，Webhook 文件必须包含 `WEBHOOK_SECRET_ENCRYPTION_KEY`，需要 OpenAI 的 API 与 Process Worker 各自包含自己的 `OPENAI_API_KEY`。不要把 `.env` 复制成五份。

首次创建五份角色文件时，先手动运行受保护的 `.github/workflows/async-production-environment-provisioning.yml`，填写当前同步 revision、服务器已加载的候选 revision、`issue-<number>` 变更引用，并先选 `plan`。入口优先使用 `async-internal` Environment Secret 中非空的 `ASYNC_DATABASE_URL`、`ASYNC_REDIS_URL`；任一覆盖值为空时，改从服务器 `root:root 0600` 的 `shared/.env` 读取对应标准 `DATABASE_URL`、`REDIS_URL`。凭证不能放在 GitHub Environment Variable 中。Secret 覆盖值只通过标准输入发送给远端脚本；两种来源都不进入 SSH/SCP argv、日志或 artifact。入口要求两个同步容器正在运行、主 API 异步入口关闭、四个异步后台容器不存在，避免改写正在使用的角色配置。

`plan` 持有与同步/异步发布相同的服务器部署锁，并在 `shared` 下的 0700 临时目录渲染候选文件：只从现有 `.env` 选取 API/Worker 共同拥有的 Agent 与 Process 配置，不复制 FAL、OSS 或其他角色 Secret；网关共享 Secret 和 Webhook 32-byte base64 Key 在服务器生成。它还要求 `.env` 中恰有一个 `DATABASE_URL`，在候选副本中只替换该行并保留其余配置。随后用候选不可变 image ID 验证连接契约与五角色环境预检，并对最终数据库连接执行只读生产数据库边界审计，确认固定 CA TLS、非管理员有效角色以及不能绕过有效角色直连；Secret 覆盖与标准环境 fallback 不能绕过该审计。Redis 在此阶段只验证 URL 契约，不证明可达性。`apply` 重复同一验证，在提交前重验同步容器形状、候选镜像、五个目标，以及原 `.env` 的文件 identity 和完整摘要，再用同文件系统硬链接逐个安装，最后以已验证候选原子替换 `.env`；所有生产配置写入入口都必须遵守同一 `deployment.lock`，脚本会拒绝在提交前已观测到的锁外漂移，但普通文件系统不能为不持锁写入方提供 CAS 保证。在最后提交点前发生目标竞态、信号或安装失败时，脚本只删除仍与本次 candidate 为同一 inode 的角色文件，不会删除并发外部替换的文件。入口不覆盖或轮换已有角色文件，也不连接 Redis、模型或 Business Capability。artifact 只含 mode、revision、变更引用、候选验证、数据库与 Redis 的配置来源，以及最终 `rollbackStatus`、`cleanupStatus`；来源只取 `protected_override`、`shared_environment`、`not_observed`，不含 URL、Secret 或摘要。失败证据只在清理完成后生成，清理或回滚不完整时本身也会失败。Runner 在脚本未启动、传输失败或输出非法时会写入脱敏的 transport/execution 失败证据；两类证据都不含 URL、Secret、摘要、临时路径或预检诊断。完成 `apply` 后必须重新运行下面的只读前置检查；它通过才能进入 internal release。

在启用任何异步容器前，可以手动运行受保护的 `.github/workflows/async-production-prerequisites-inspection.yml`。输入当前同步生产 revision 与服务器上已加载的候选 revision；入口只读取服务器现状，不执行 migration、不启动或替换生产服务容器，也不连接 PostgreSQL、Redis、模型或 Business Capability。它要求当前主 API 与内部 Business API 都正在运行且匹配指定 revision、主 API 的异步入口精确关闭、四个异步后台容器尚未存在，并用候选镜像的不可变 image ID 创建无网络且自动删除的临时容器，分别执行五个角色的环境预检。检查期间若候选 tag 被重新指向其他镜像，整个检查 fail closed。

证据只包含 revision 和布尔结果：数据库 CA 是否存在、六份配置中的 `DATABASE_URL` 摘要是否一致、Dispatcher/Worker/Webhook 的 `REDIS_URL` 摘要是否一致、Redis URL 是否使用 `rediss://`、网关共享 Secret 是否至少 32 bytes、Webhook 加密 Key 是否为规范的 32-byte base64，以及各角色文件是否为非符号链接的 `root:root 0600` 文件、变量名是否全部属于该角色的显式 allowlist、预检是否通过。存在未授权或重复变量时，不会把该文件注入候选预检容器。`redisTlsConfigured` 只证明 URL scheme，不证明网络可达、服务端证书有效或 Redis 高可用；角色预检也不能替代 Construction、readiness、备份恢复、容量和真实网关 smoke。artifact 不保存 URL、Secret、摘要、预检诊断或业务内容。

手动运行时填写四项：完整 40 位 `candidate_sha`、生成其 release artifact 的 `candidate_ci_run_id`、已复核的 PostgreSQL `backup_id` 和审计用 `recovery_actor_id`。入口核对 CI run 的 commit、workflow 路径和完成状态，并要求该 run 的 `Check and build` 与 `Async durable acceptance` 都成功；随后只下载 `pipipi-<commit>` artifact，不重新构建镜像。

远端 [`../ops/deploy-async-internal.sh`](../ops/deploy-async-internal.sh) 固定执行以下门禁：

1. 验证输入、Docker/Compose、候选文件、数据库证书、五份角色 Secret 和可回滚的当前形状。
2. 加载 CI 镜像，记录 archive SHA-256 与镜像 ID，并以安全的 Compose config 验证候选形状。
3. 在每个角色自己的 env file 中运行环境预检；输出只含角色与变量名称，不含配置值。
4. 用 Dispatcher 的数据库连接和生产容器相同的 host network 执行只读生产数据库边界审计；只有固定 CA TLS、非管理员有效角色且不能绕过角色直连时才允许进入 migration。脱敏结果单独保存为 `database.json`。
5. 在同一 host network 用候选镜像连续执行两次 migration；只有第二次 `verificationCount=0` 才继续。失败不执行 down，已经应用的 additive schema 保留。
6. 在同一 host network 不传 cursor 执行 `recover --dry-run --mode=all`，遍历全部批次；只有至少一批、每批均为 manual/all/dry-run、累计 `failed=0` 且最后一批没有 `nextCursor` 才继续。
7. 先启动 Business API、Retention Cleaner、Process Dispatcher、Process Worker 和 Webhook Worker 并等待各自 ready，再单独启动 API。
8. 核对六个容器的镜像 ID、revision label、API 的 `internal` 阶段、Process Queue 两端 identity 和 Webhook Queue identity。

任一门禁在角色切换前失败时，当前服务保持原样；角色切换后失败、Actions 取消、SSH 断开或进程收到 `HUP`/`INT`/`TERM` 时，脚本恢复先前保存的同步或异步 Compose 形状和镜像。回滚不会执行 migration down，也不会删除 PostgreSQL Run、Outbox 或 Queue。已有异步形状升级时，候选 Queue identity 必须与当前容器一致。

每次尝试都在服务器 `shared/async-release-evidence/<commit>-<run>-<attempt>/` 写入且只回收 `evidence.json`、逐角色预检、`database.json`、migration 摘要、完整 Recovery batch JSONL 和 readiness 响应，并由 Actions 以 `pipipi-async-internal-evidence-*` artifact 保存 30 天。回滚 Compose 快照位于证据目录之外，结束后连同远端候选归档和 Compose 文件按精确路径删除。数据库审计证据只包含数据库 identity 摘要和连接边界布尔值，不包含 URL、角色、主机或原始错误。其余证据包含 commit、两个 Actions run ID、backup ID、镜像 ID/archive 摘要、前一形状、非秘密 Queue identity、migration/Recovery/角色门禁与回滚结果；不包含 Secret、连接 URL、服务器 Compose 快照或业务输入输出。该入口把 stage 固定为 `internal`，不包含 canary/production 提升动作。

### 真实网关 smoke 与安全回滚

候选 internal 发布成功后，手动运行 `.github/workflows/async-internal-smoke.yml`，填写同一 `candidate_sha`、对应 release run/attempt 和受控失败请求的公开 error code。Job 同样绑定 `async-internal` Environment，并与发布共享 `pipipi-production-release` 并发组；它不会提升 canary 或 production。

baseline smoke 只向真实 HTTPS 网关发送两个操作者的外部 Authorization。每个请求还故意携带伪造的两个内部身份头；只有网关删除它们并为 caller A 注入稳定 subject 与正确共享凭证，成功与稳定业务失败 Run 才能被接受并查询到终态。caller B 对 caller A Run 与未知 Run 必须得到完全相同的 404 响应。smoke 同时验证网关 health/readiness 和同步 `/execute`。

运行前必须为 caller A 预注册至少一个受控、启用中的 Webhook Endpoint；它的目标与 Secret 仍由服务端管理，不进入 smoke 请求或证据。baseline 证据收集器会在有界窗口内等待成功与失败两个终态各自产生至少一条 Delivery，前后审计再证明 Delivery 总数和覆盖的 Run 数量不变；单个 Run 有 Delivery 或 `0 → 0` 都不算通过。

远端证据收集器核对六个角色的 health/readiness 与同一 revision，保存一次不含业务内容的 Async Operations snapshot，并要求两个 Run 都产生 submission accepted、terminal observed、Process Outbox published 和 Worker finished 关联日志。数据库审计只输出 owner/idempotency 是否存在、Run/Event/Outbox/Delivery 数量及 additive schema 是否存在，不输出 owner、幂等键或连接地址。

回滚演练前，workflow 在服务器创建绑定 candidate revision 和本次 Actions run 的有限期 smoke lease；同步与异步部署入口都在发布锁内拒绝该 lease，避免 smoke 对错误 revision 产生真实副作用。回滚演练随后在宿主机 `shared/async-control/intake-disabled` 建立服务端 marker。API 每次只在 `POST /process-runs` 边界读取该 marker：关闭时返回 `503 ASYNC_INTAKE_CLOSED`，`GET /process-runs/{runId}`、`POST /execute`、health 和 readiness 不受影响。控制脚本只接受当前 internal revision，持有发布锁，并把 marker 绑定到本次 Actions run；它拒绝覆盖或移除其他操作拥有的 marker。最长 10 分钟的令牌化自动恢复只移除本次 marker；本次关闭成功后，workflow 的 `always()` 收尾还会立即恢复。回滚 smoke 通过真实网关证明新提交被拒绝、两个已接受终态仍可查询、同步执行继续工作，再比较前后数据库审计，确认 Run、owner、idempotency、Event/Outbox、Delivery 和 schema 均未删除。smoke lease 也有自动到期，并由 workflow 的 `always()` 收尾按 owner token 释放。

artifact 只保存 baseline/rollback 时间线、revision、Run ID、request ID、公开状态/错误码、角色状态、运维快照、关联日志与布尔审计。禁止字段检查会拒绝幂等键、业务 input/output、Prompt、Authorization、Secret、Endpoint URL 和数据库/Redis URL。真实 Environment 凭证、网关配置和受控请求尚未配置时，不得声称此 smoke 已在 internal 运行；本地确定性与真实依赖验收只证明工具和应用边界。

## Dispatcher 与 Worker 隔离故障演练

`.github/workflows/async-dispatcher-worker-drill.yml` 是 Dispatcher/Worker 故障演练的受保护手动入口。它绑定 required-reviewer 管理的 `async-staging` Environment，检出操作者给出的完整候选 SHA，只启动 Actions runner 内一次性的 PostgreSQL/Redis Compose project；不读取生产 Secret、不连接生产依赖、不接生产流量，也不包含 canary 或 production 提升。禁止在生产环境注入这些故障。

一次运行必须连续通过三组真实竞态：

1. Dispatcher 已把 Job 发布到 Queue、但尚未确认 PostgreSQL Outbox claim 时重启；claim 到期后的重发必须由 Queue 按 `runId` 去重，最终只有一个权威 Run 和 Attempt。
2. Worker claim 到期后由兼容 Worker 建立新 Attempt；旧 token 的晚到完成必须被 fencing 拒绝，终态 Run 的重复 Job 必须被消费并忽略，不能增加 Attempt 或改写终态。
3. 滚动升级时先让新 Worker ready，再停止旧 Worker 领取新 Job。旧 Worker 超过 `PROCESS_WORKER_SHUTDOWN_GRACE_MS` 后先释放 PostgreSQL claim，再取消执行并在有界窗口内把 BullMQ Job 收尾到可恢复状态；Reconciler 重投后由新 Worker 建立下一 Attempt。时间线必须证明 new-ready 在 old-stop 之前。

每个场景都查询 PostgreSQL，要求一条 `process_runs` 权威记录、一条 succeeded/failed 公开终态 Event，以及按顺序保存的 Attempt 结果。受控 Business Capability 记录调用次数，并以 `runId` 去重副作用：执行可能发生多次，副作用只能一次。因此运行结论必须写成“BullMQ 唤醒至少一次，PostgreSQL 决定权威状态，下游按 `runId` 幂等”，不得声称 exactly-once。

本地复现使用：

```bash
ASYNC_DISPATCHER_WORKER_DRILL_REVISION="$(git rev-parse HEAD)" \
ASYNC_DISPATCHER_WORKER_DRILL_EVIDENCE_FILE=artifacts/dispatcher-worker-drill.json \
npm run test:drill:dispatcher-worker:local
```

脚本只接受名称以 `_test` 结尾的 PostgreSQL database 和本机非零 Redis database，开始前重建 schema/清空测试 DB，结束或失败后删除 Compose 容器、volume 与网络。JSON 证据包含候选 revision、三个 Run ID、Attempt number/status/result code、服务端时间线、单一终态/权威记录/幂等副作用计数和非生产流量声明；禁止保存 claim token、幂等键、业务 input/output、Prompt、Authorization、Secret 或数据库/Redis/Endpoint URL。Actions artifact 保留 30 天，发布人员必须将通过的 workflow run 与候选 commit 一起写入发布记录。

## Migration 与部署顺序

所有 migration 必须由一次性 Job 在新代码接流量前执行：

> 警告：`db:migrate` 会写 PostgreSQL schema。只在备份和恢复验证完成后，对已经核对的目标数据库执行；失败时停止部署，不运行 migration down。

```bash
DATABASE_URL='postgres://service-user:replace-me@database.internal/business_processing' \
npm run db:migrate
```

当前 migration `001` 至 `008` 采用向前兼容的表、列和索引变化。`007_process_run_admission` 只增加 caller backlog 部分索引，`008_process_run_observation` 只增加派生观测表；旧进程可以继续读写。按照以下顺序部署：

| 步骤 | 动作 | 成功信号 | 失败后的安全动作 |
| --- | --- | --- | --- |
| 1 | 记录旧镜像摘要、当前 migration 版本、数据库备份 ID、Queue prefix 和基线运维快照 | 证据可由另一名发布人员复核 | 不开始变更；补齐备份或证据 |
| 2 | 运行 migration Job，再次运行 `npm run db:migrate` | 第二次运行显示无待执行 migration，`007` 索引存在 | 停止部署并保留数据库；从 migration 日志诊断，不运行 down |
| 3 | 分别完成环境预检，再部署 Retention Cleaner、Process Dispatcher、Process Worker 和 Webhook Worker，不接外部流量 | 预检与所有角色 readiness 成功，Queue 名称与 prefix 一致 | 停止有问题的角色并回滚镜像；保留 additive schema 和 PostgreSQL 数据 |
| 4 | 运行人工全量 Queue Recovery dry-run，保存完整批次链 | 根批次从空 cursor 开始，所有批次 `completed`、最终 cursor 为空且 `failed=0` | 不执行 apply，不提升流量；修复 Queue、配置或候选异常后重跑完整链 |
| 5 | 部署 API，保持 `ASYNC_RELEASE_STAGE=internal`，只允许内部合成调用方 | 提交、owner 查询和 Webhook smoke 到达预期终态 | 设置 `ASYNC_PROCESS_RUNS_ENABLED=false` 或回滚 API；保留 GET 所需数据库 |
| 6 | 采集至少一个正常观测窗口并完成故障演练，再依次提升到 `canary` 和 `production` | readiness、Dashboard 和告警均通过，演练证据完整 | 停止提升并退回上一个阶段；按对应告警章节处置 |

同一 Queue 上滚动升级 Worker 时，先让新 Worker ready，再停止旧 Worker 领取新 Job，并给旧 Worker 至少 `PROCESS_WORKER_SHUTDOWN_GRACE_MS` 完成或释放 claim。该值默认 30 秒、上限 60 秒；生产 Compose 的 `stop_grace_period` 固定为 2 分钟，覆盖应用 grace 和取消后的最长 1 秒 Queue 收尾，避免容器先发出 `SIGKILL`。Job envelope 始终只有 `{ schemaVersion: 1, runId }`；新旧 Worker 都从 PostgreSQL 选择准确 Registration。不要同时改变 schema、Process 语义和 Queue prefix。

### 显式单服务器 Compose 形状

默认 [`compose.production.yaml`](../compose.production.yaml) 只包含 API 与内部 CRT Business API，并固定 `ASYNC_PROCESS_RUNS_ENABLED=false`。异步发布使用 [`compose.production.async.yaml`](../compose.production.async.yaml) 作为叠加层；它不会单独工作，也不会被当前自动部署激活。检测到任一异步角色容器时，默认自动部署也会拒绝继续，避免未经停流和排空就隐式退回同步形状。release artifact 会携带同一 commit 的默认 Compose、异步叠加层和镜像归档，发布人员必须核对三者来自同一 revision。叠加层用 `!override` 替换 API 的 Secret 文件列表，因此部署机必须提供 Docker Compose 2.24.4 或更高版本；`npm run check:deployment:async-shape` 会先检查版本。

以下变量是 Compose 形状本身的非秘密输入；`PIPIPI_IMAGE`、`PIPIPI_REVISION`、`PIPIPI_ASYNC_RELEASE_STAGE`、四个 Queue 配置和五个角色 env file 路径缺少任一项都会在渲染时失败。API、Dispatcher、Process Worker、Webhook Worker 与 Cleaner 分别读取自己的 Secret 文件，避免把网关、模型、Webhook 加密或 Redis 凭证注入无关角色；默认 Business API 继续读取 `PIPIPI_ENV_FILE`。叠加层不创建 PostgreSQL 或 Redis。

```bash
export PIPIPI_IMAGE='pipipi:<commit>'
export PIPIPI_REVISION='<commit>'
export PIPIPI_ASYNC_RELEASE_STAGE='internal'
export PIPIPI_ENV_FILE='/opt/pipipi/shared/.env'
export PIPIPI_ASYNC_API_ENV_FILE='/opt/pipipi/shared/async-api.env'
export PIPIPI_PROCESS_DISPATCHER_ENV_FILE='/opt/pipipi/shared/process-dispatcher.env'
export PIPIPI_PROCESS_WORKER_ENV_FILE='/opt/pipipi/shared/process-worker.env'
export PIPIPI_WEBHOOK_WORKER_ENV_FILE='/opt/pipipi/shared/webhook-worker.env'
export PIPIPI_RETENTION_CLEANER_ENV_FILE='/opt/pipipi/shared/retention-cleaner.env'
export PIPIPI_PROCESS_QUEUE_NAME='process-runs'
export PIPIPI_PROCESS_QUEUE_PREFIX='pipipi-production'
export PIPIPI_WEBHOOK_QUEUE_NAME='webhook-deliveries'
export PIPIPI_WEBHOOK_QUEUE_PREFIX='pipipi-production'

docker compose \
  --project-name pipipi \
  --file compose.production.yaml \
  --file compose.production.async.yaml \
  config --quiet
```

CI 用 `npm run check:deployment:async-shape` 以安全占位值执行真实 Compose 渲染，并验证默认形状未启用异步、全部角色使用同一镜像与 revision、Process Queue 配置一致、各角色拥有预检/启动/readiness，以及缺参会明确失败。它不读取生产 Secret，也不启动服务。

完成 migration 后，仍按上表顺序分两次显式启动。第一条命令只启动后台角色；Process Worker 会带起内部 Business API，但不会带起 API。确认四个角色都 ready、完成 Queue Recovery dry-run 后，第二条才启动 API：

```bash
docker compose \
  --project-name pipipi \
  --file compose.production.yaml \
  --file compose.production.async.yaml \
  up -d retention-cleaner process-dispatcher process-worker webhook-worker

docker compose \
  --project-name pipipi \
  --file compose.production.yaml \
  --file compose.production.async.yaml \
  up -d api
```

API 使用 4300，内部 CRT Business API 使用 4400，Dispatcher、Process Worker、Webhook Worker 和 Retention Cleaner 的检查端口依次为 4310–4340。所有容器使用 host network；防火墙不得向公网开放这些应用端口，外部流量只能经过可信网关。

从异步形状退回同步默认形状时，先关闭新异步提交并按回滚章节处理已经接受的 Run，再沿用同一个 `pipipi` project 只加载基础文件。`--remove-orphans` 会停止并删除四个异步角色容器；省略它会让旧 Worker 在默认 API 已关闭异步入口后继续运行：

```bash
docker compose \
  --project-name pipipi \
  --file compose.production.yaml \
  up -d --force-recreate --no-build --remove-orphans
```

## 配置与分阶段启用

每个角色只注入自己拥有的配置。以下变量没有代码默认值，空字符串和纯空白都视为缺失：

| 角色 | 必填环境变量 |
| --- | --- |
| `api` | `BUSINESS_API_BASE_URL`；`PI_PROVIDER=openai` 时还需 `OPENAI_API_KEY`；启用异步入口后还需 `DATABASE_URL`、`ASYNC_GATEWAY_SHARED_SECRET`、三个 `PROCESS_RUN_*_RETENTION_MS`、`ASYNC_RELEASE_STAGE`、`ASYNC_GLOBAL_BACKLOG_LIMIT`、`ASYNC_CALLER_BACKLOG_LIMIT`、`ASYNC_BACKLOG_RETRY_AFTER_SECONDS` |
| `process-dispatcher` | `DATABASE_URL`、`REDIS_URL` |
| `process-worker` | `BUSINESS_API_BASE_URL`、`DATABASE_URL`、`REDIS_URL`、三个 `PROCESS_RUN_*_RETENTION_MS`、`PROCESS_RUN_RECORD_STORE`、`PROCESS_RUN_RECORD_CONTENT`；非生产文件存储还需 `PROCESS_RUN_RECORD_DIRECTORY`；生产固定为 `postgres` 与 `accepted-input-and-output`；`PI_PROVIDER=openai` 时还需 `OPENAI_API_KEY` |
| `webhook-worker` | `DATABASE_URL`、`REDIS_URL`、`WEBHOOK_SECRET_ENCRYPTION_KEY` |
| `retention-cleaner` | `DATABASE_URL` |
| `async-operations` | `DATABASE_URL`、`REDIS_URL` |
| `process-recovery` | `DATABASE_URL`、`REDIS_URL`；运行恢复命令时还需 `PROCESS_RECOVERY_ACTOR_ID` 或 `--actor` |

构建完成后，在每个工作负载自己的 Secret 注入环境中运行对应预检。例如：

```bash
npm run check:deployment-env -- process-dispatcher
npm run check:deployment-env -- process-worker
npm run check:deployment-env -- webhook-worker
npm run check:deployment-env -- retention-cleaner
npm run check:deployment-env -- api
```

异步生产 Compose 强制覆盖 `PROCESS_RUN_RECORD_STORE=postgres` 和 `PROCESS_RUN_RECORD_CONTENT=accepted-input-and-output`，生产预检也会拒绝其他值。Worker 与 API 共用 Run Observation Module：Worker 写入异步终态 Run Record 和 Attempt Activity Archive，API 的 Console Read Port 读取同一 PostgreSQL 数据。这样不会出现异步执行成功但控制台历史、统计和活动时间线为空，或记录随 Worker 容器删除的合法生产配置。

预检不连接 PostgreSQL、Redis、模型或 Business Capability，不输出配置值，并在一次失败中列出该角色全部缺失变量。实际 Construction Root 会重复检查存在性，再校验格式和跨字段约束；`GET /readyz` 随后验证 migration 与外部依赖。预检通过不能替代 Secret、网络、容量和 smoke 门禁。

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

提升只使用受保护、手动触发的 `.github/workflows/async-promote-release.yml`。先为同一完整 commit 收集成功的 internal release、真实网关 smoke、Dispatcher/Worker 演练、Redis 重建演练和 Webhook/观测演练 artifact；其中任何 revision、migration、Recovery、readiness 或演练结论不一致都拒绝执行。批准顺序固定为：

1. `internal/0% → canary/0%`，只改变 API 的 `ASYNC_RELEASE_STAGE`；
2. `canary/0% → 1% → 5% → 25%`，每次只改变可信网关流量；
3. 在 `canary/25%` 跨过输入的批准观测窗口（不得短于 3600 秒，峰值窗口更长时使用获批值），且容量、费用与 critical alert 继续通过；
4. `canary/25% → production/25%`，只改变 API stage；
5. `production/25% → 50% → 100%`，每次只改变可信网关流量。

回退只能按相邻状态逆序执行，不能跨比例或跨阶段。每次调用记录开始/完成时间、前后 stage 与比例、镜像摘要、由 revision 和非秘密 Queue identity 计算的配置摘要、前后 critical snapshot、五角色 readiness、来源演练标识和回滚负责人。任何 readiness、容量、费用或 critical alert 失败都会恢复原变量与原 promotion state；API stage 变化使用 `--no-deps api`，后台兼容 Worker 容器 ID 必须保持不变，PostgreSQL 和已接受 Run 不被删除。既有 owner GET 是否可用还由同 revision internal smoke 的 intake-closed 证据前置证明。不要通过临时放大阈值绕过门禁。

服务器必须预置两个由平台拥有、不可由产品请求选择的可执行 Adapter：

- `shared/async-control/set-traffic get <revision>` 只输出当前批准比例；`set <revision> <percent>` 原子修改可信网关路由，并在失败时返回非零；
- `shared/async-control/check-critical-alerts <revision>` 输出一份不含业务内容的 JSON，至少包含 `schemaVersion=1`、`revision`、五分钟内的 `measuredAt`、`criticalAlertsClear`、`capacityWithinBudget`、`costWithinBudget` 和 snapshot。

`async-internal`、`async-canary`、`async-production` Environment 都必须配置 required reviewer；普通 CI、push 和默认 production workflow 不能调用这两个 Adapter。提升证据保留 90 天。未实际运行受保护 workflow、没有真实网关 Adapter 或没有批准观测窗口时，只能声称发布编排已验证，不能声称 production 流量闭环已完成。

### 受控 FAL/OSS 付费异步 smoke

只有同 revision promotion 已进入 `canary` 或 `production` 且真实流量至少为 1% 后，才可人工运行 `.github/workflows/async-paid-image-smoke.yml`。`async-paid-smoke` Environment 必须配置 required reviewer，并提供：

- Secret `PAID_ASYNC_CALLER_AUTHORIZATION`：获准执行一次付费图片操作的真实网关 caller 凭证；
- Secret `PAID_ASYNC_SOURCE_IMAGE_URL`：FAL 可匿名读取且有效期覆盖 Queue/FAL 窗口的非敏感公网 HTTPS 图片；
- Variable `PAID_ASYNC_GATEWAY_URL`：目标真实 HTTPS 网关；
- Variable `PAID_ASYNC_EXPECTED_OSS_HOST` 与 `PAID_ASYNC_EXPECTED_OSS_PATH_PREFIX`：最终产品 PNG 获准落入的位置。
- 生产发布共用的 `SSH_PRIVATE_KEY`、`SSH_KNOWN_HOSTS`、`REMOTE_HOST`、`REMOTE_USER` 与 `REMOTE_PATH`：只用于在提交前核对六个容器 revision、CRT Business API health/Provider、API stage 和网关实际比例。

目标 CRT Business API 还必须由部署 Secret 固定 `IMAGE_PROVIDER=fal`、`FAL_KEY` 和正式 OSS 配置；workflow 不读取这些供应商凭证。操作者填写同 revision promotion run/attempt、`APPROVE_ONE_PAID_CRT_OPERATION`、两位小数的 USD 费用上限、非秘密批准编号和 60–900 秒查询期限。付费 smoke 与发布/提升共用 `pipipi-production-release` 并发组；付费请求前再次核对六个活跃容器（含 CRT Business API）的 revision、Business API health、固定 FAL/阿里云 OSS Provider、stage 和 traffic，拒绝拿旧 artifact 或错误 Provider 测试新部署。没有逐次费用授权不得运行，也不得用普通 CI 或定时任务调用。

每个 workflow run 固定唯一 Registration `crt-interface-image/v1`，固定 `经典`、`4:3`、`normal`，产品 body 中没有 Skill、Prompt、模型、供应商、OSS、Queue 或运行配置。smoke 为一个逻辑操作生成一个 caller-scoped idempotency key；受控标准路径在首次 POST 收到 durable acceptance 的 `202` 与 `Location` 后主动丢弃响应 body，再以同一 body/key replay，并要求恢复到同一个 `runId`。若首次响应连 header 都因真实 transport 故障丢失，smoke 仍以同一 key replay，并从恢复出的 `runId` 继续；同 key 的服务端唯一 Run invariant 已由前置确定性和 staging 门禁验证。两次提交各有独立的 30 秒传输期限，owner-query 的 60–900 秒期限只从 replay 恢复 durable acceptance 后开始。之后结束首次查询会话，再用同一 owner 的 GET 恢复，绝不生成新 key 或第三次提交。证据单列 Process Run 的 `unknown`、`failed` 或 `succeeded` 终态；终态失败还保存稳定公开 error code。成功后只允许不跟随重定向地从获准 OSS host/prefix 下载最终对象，并验证 PNG 内容、声明尺寸、不透明和 `经典` 调色板，由此覆盖真实网关、异步 API、Dispatcher、Worker、FAL URL edit、finalizer 和 OSS。

90 天 artifact 只含候选 revision、固定 Process identity/version、Run ID、终态、恢复判据、对象 identity/content SHA-256、字节/尺寸和获批 USD 上限/批准编号。source URL、最终/原始对象 URL、Authorization、idempotency key、Prompt、业务 input/output、FAL/OSS Secret 和内部异常正文都禁止进入日志或证据。workflow 不自动重试、不改变 release stage/流量，也不触发 production promotion。未获得明确费用批准或未实际运行该受保护 workflow 时，不得声称真实 FAL/OSS 付费异步闭环通过。

## 容量拒绝与恢复

API 在 PostgreSQL 接收事务内先处理幂等重放，再串行检查 queued + running backlog。相同 caller/key/fingerprint 的重放不消耗新名额，也不会因 backlog 已满而失败。

| 条件 | HTTP | 稳定错误码 | 调用方动作 |
| --- | ---: | --- | --- |
| caller 达到上限 | `429` | `CALLER_BACKLOG_LIMIT_REACHED` | 等待 `Retry-After`，继续查询既有 Run |
| 全局达到上限 | `503` | `ASYNC_SERVICE_CAPACITY_REACHED` | 等待 `Retry-After`，继续查询既有 Run |
| PostgreSQL 或身份依赖不可用 | `503` | `ASYNC_SERVICE_UNAVAILABLE` | 等待 `Retry-After`；不要创建新 idempotency key |
| 运维关闭新提交 | `503` | `ASYNC_INTAKE_CLOSED` | 不提交新操作；既有 owner GET 与同步 `/execute` 保持可用 |

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
| Attempt 活动 | `process_run_attempt_finished.durationMs`、`process_run_activity_finished.durationMs` | 按 Process、活动与 outcome 定位慢阶段或失败阶段 |
| 失败与 stuck | `failureRateRecent`、`persistence.runs.stuck` | 业务/依赖失败和长期 queued/租约过期 Run |
| Outbox | `oldestProcessLagMs`、`oldestWebhookLagMs` | PostgreSQL commit 到入队确认的延迟 |
| Webhook | `persistence.webhooks.failureRateRecent`、`oldestPendingAgeMs` | 终态投递失败和重试积压 |
| Storage | `persistence.storage.asyncTablesBytes` | 当前体积；监控系统计算日增长率 |
| Cleanup/Recovery | `lastDeferredRuns`、`lastFailedItems`、完成时间 | 内容清理受引用阻塞或 Queue 恢复失败 |

`ops/async-observability.json` 把 `runId`、`eventId`、`deliveryId` 固定为调查关联键，并把 Webhook failure/Queue age、Recovery 超期或 failed item 标为 critical。staged release 除检查告警外，仍必须调用 API readiness；Dashboard 正常不能替代 PostgreSQL 容量、Outbox 和完整 Recovery 门禁。

结构化日志的关联链为：API/Worker 使用 `runId`，Outbox 同时使用 `messageId + eventId + runId|deliveryId`，Webhook Attempt 使用 `deliveryId + eventId`。Process Attempt 与 activity 由 Pino 输出；`level=30|40|50` 分别表示 `info|warn|error`。排查单个 Process Run 时，先按 `runId` 过滤，再按 `attemptNumber + sequence` 排序；`process_run_activity_started` 表示当前阶段，配对的 `process_run_activity_finished` 给出 outcome 与耗时，`process_run_attempt_finished` 给出 Attempt 结果和稳定错误码。API 与 Worker 必须使用相同的 `PROCESS_RUN_LOG_LEVEL`，生产保留完整时间线时设为 `info`。

日志不得包含 caller 原始凭证、idempotency key、accepted input、output、Prompt、Tool 参数、模型消息、隐藏推理、Webhook payload、Endpoint URL、签名 Secret、数据库/Redis URL、远端响应正文或内部异常消息。需要查看业务结果时，使用 owner-authenticated GET；不要从日志还原内容。Activity Log 是 best-effort 观测；缺失事件不能用来推断权威状态，状态与恢复仍以 PostgreSQL 为准。

## Queue 对账与 Redis 重建

人工恢复默认 dry-run，必须给出可审计 actor：

> 警告：dry-run 也会写恢复审计；`--apply` 还会写 BullMQ、确认 Process Outbox 并写逐项审计。只在获批的 staging 演练或事故处置中执行，先逐字核对 `DATABASE_URL`、`REDIS_URL`、Queue name/prefix 和 actor；任何批次失败时停止，不继续放量。

```bash
PROCESS_RECOVERY_ACTOR_ID=operator:replace-me \
npm run recover:queue -- --mode=all

PROCESS_RECOVERY_ACTOR_ID=operator:replace-me \
npm run recover:queue -- --apply --mode=all
```

先保存 dry-run 的 candidate、missing、terminal、invalid、active lease、pending Outbox 和 failed 计数。只有完整链从空 cursor 开始、每个批次都完成、最终 `nextCursor` 为空、汇总 `failed=0` 且影响范围符合事故判断时执行 `--apply`。canary/production readiness 也按这条完整链判定，不接受单个中间批次。恢复命令以 PostgreSQL 非终态 Run 为候选；终态 Run 不会重建。活跃 running 租约只报告 `deferred`，过期后下一轮才重入队。成功入队或确认有效 Job 后才确认 pending Outbox。

Redis 数据丢失的标准动作：

1. 把异步 API 降到 `internal` 或关闭新提交；保留 GET 查询。
2. 停止 Dispatcher 自动写 Queue，等待当前恢复批次结束。
3. 恢复 Redis 服务和正确 Queue prefix，确认两个 Queue ready。
4. 执行全量 dry-run；保存报告。
5. 执行全量 `--apply`，重复 dry-run 直到 missing/invalid/failed 都为零。
6. 恢复 Dispatcher 与 Worker，观察 queued age、Outbox lag、重复/ignored 日志和终态增长。
7. 重新通过 canary readiness 后再增加流量。

不要把 Queue count 当作产品 backlog，也不要删除 PostgreSQL Run 来“清空队列”。

### 可复核的隔离演练入口

`.github/workflows/async-redis-rebuild-drill.yml` 把上述步骤固化为受保护的 `async-staging` 手动演练。它固定完整候选 SHA 并使用一次性 PostgreSQL/Redis：先在 Redis 不可达时 durable accept 并保留 owner GET/pending Outbox，再恢复普通 Dispatcher relay；随后清空 Queue，构造 missing、terminal、invalid、active lease 与 pending Outbox 候选。演练从空 cursor 保存完整 dry-run 批次链，代码只有在最终 cursor 为空且累计 `failed=0` 后才执行带 actor 的 apply。活跃 lease 首轮只记录 `deferred`；到期后的独立受审计 apply 才重建。全部 Run 收敛后，重复 dry-run 必须得到 missing、invalid、failed 全零。

证据保存 revision、actor、Run ID、每批 recovery ID/cutoff/cursor、candidate/missing/terminal/invalid/deferred/pending Outbox/failed 统计和逐项非秘密动作；不保存业务 input/output、claim token、幂等键或连接地址。它与其他 staging fault drill 共用串行并发组，不读取生产 Secret、不连接生产依赖，也不从 Queue 反向创建或删除 PostgreSQL Run。

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

受保护的 `.github/workflows/async-webhook-observability-drill.yml` 固定候选 SHA，在一次性 PostgreSQL/Redis 和本地测试 Endpoint 上自动执行这条链。它保存两个 Process Run、Delivery/Event ID、失败到恢复的 Attempt、完整无内容运维快照与关联日志；同时证明缺少新鲜完整 Recovery 时 canary readiness 拒绝，补齐后 canary/production readiness 通过。该 workflow 与其他故障演练共用 `async-staging` 串行组，不接生产流量，也不改变发布阶段。

### 回滚

1. 把新提交流量降到零；internal 单服务器形状优先使用受控 intake marker，不要把 `ASYNC_PROCESS_RUNS_ENABLED=false` 当作保留 GET 的开关。同步 `/execute` 继续服务。
2. 让已接受 Run 由兼容 Worker 排空；若必须停 Worker，保留 PostgreSQL 并在恢复后重建 Queue。
3. 回滚应用镜像，不自动执行 migration down。验证 health/readiness、既有 GET 和同步回归。
4. 修复后用同一 PostgreSQL 数据与 Queue prefix 恢复，先 dry-run Queue Recovery，再 internal/canary。

## 告警处置

### Run 或 Process Queue 持续增长

比较 PostgreSQL `queued/running` 与 BullMQ waiting/active/delayed。若 PostgreSQL 增长但 Queue 为空，检查 Outbox 和 Dispatcher，再运行 Queue Recovery dry-run；若 Queue 与 active 同时增长，检查 Worker readiness、Business Capability 配额、执行耗时和超时。不要先增加 API backlog 上限。

### Outbox 延迟

先区分 Process 与 Webhook Outbox，并确认指标只统计 `availableAt` 已到期的消息。确认对应 Dispatcher/Worker ready、Redis 可达和 Queue prefix 一致。检查 Outbox claim 是否过期；普通故障恢复后 relay 会重试。Process Outbox 持续不一致时运行 dry-run，对 `pendingOutbox` 候选执行受控 apply。只有有效或新建 Job 才允许确认 Outbox。

### Webhook 失败或积压

先区分单 Endpoint 与全局网络问题。`410` 和 target rejection 会停用 Endpoint；`429/5xx/network` 按策略重试。确认 Process Run 终态未改变，必要时隔离故障 Endpoint或扩容独立 Webhook Worker。只有目标恢复且 actor 有权限时执行 replay。

### 存储增长或清理滞后

检查 `asyncTablesBytes` 日增长、最近 cleanup 时间、`lastDeferredRuns` 和 `retention_cleanup_sweep_failed` 日志告警。失败或超过两个清理周期没有完成记录时，先停止内容保留策略变更并检查数据库锁、连接与批次错误；deferred 通常表示 pending Outbox 或仍在保留期内的 Delivery 引用，先修复投递链。不要手工删除关联行。`005_retention_cleanup` 已清空内容后不能安全回滚为旧的非空 schema；需要恢复内容时使用数据库备份。

## 回滚边界

- `007_process_run_admission` 只增加索引；停止新 API 并确认无新版本进程依赖后可以删除，但事故中保留索引更安全。
- `006_queue_recovery_audit` 的表可被旧版本忽略。停止 Recovery 后才能执行 down；保留审计通常优于删除。
- `005_retention_cleanup` 在任何 input/result 已清除后会拒绝 down。此时继续使用兼容代码，或从清理前备份恢复；不能伪造缺失内容。
- `004_webhook_endpoint_security` 在存在 Endpoint 时不允许降级。先停 Webhook Worker并保留加密数据，不能把信封当成明文 Secret。
- Redis Queue 可重建，PostgreSQL 不可用 Queue 反向重建。任何回滚都不得删除已接受 Run、owner、幂等键或未完成 Delivery。

发布证据至少保留：commit 与镜像摘要、migration 版本、配置非秘密摘要、备份 ID、五个角色 readiness、观测快照、人工全量 Recovery 报告、演练 Run/Event/Delivery ID、灰度时间线和回滚负责人。`Async staged promotion` 为每次 attempt 保存 `evidence.json`、五角色变更前后 readiness 和 critical snapshot；即使自动回退，也要上传失败 gate 与回退结果。证据禁止包含 Secret、连接 URL、请求正文、幂等键、claim token、Prompt、Webhook payload 或业务输出。
