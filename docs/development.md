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

### 新闻图片内部评测

受控测试环境设置 `INTERNAL_EVAL_ENABLED=true` 后，可调用 `POST /internal/eval/execute`。该调用会访问文本模型、图片供应商和对象存储，产生费用和外部写入。部署方必须通过可信网关限制调用方。完整请求、响应和错误契约见[内部新闻图片评测接口](api.md#内部新闻图片评测)。

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
| `npm run dev:console` | 启动控制台的 Vite 开发服务器，接口代理到本地 `:4300` | 否；需要另开一个 `npm run dev` |
| `npm run check` | 只读运行 Biome 格式、lint 和 import 排序检查 | 否 |
| `npm run check:fix` | 写入 Biome 格式和安全修复 | 否；会修改工作区文件 |
| `npm run lint` | 只读运行 Biome lint | 否 |
| `npm run format` | 用 Biome 格式化受管文件 | 否；会修改工作区文件 |
| `npm run typecheck` | 严格 TypeScript 检查，覆盖服务端与控制台两个 project | 否 |
| `npm test` | 运行确定性测试 | 否 |
| `npm run test:watch` | 监听并运行 Vitest | 否 |
| `npm run build` | 编译 `src/` 到 `dist/`，并把控制台构建到 `dist/console` | 否 |
| `npm run build:console` | 只构建控制台 | 否 |
| `npm run test:integration:observation` | Run 观测的 PostgreSQL 契约测试 | 是，需要名称以 `_test` 结尾的库 |
| `npm run check:deployment-env -- <role>` | 从已编译产物聚合检查一个部署角色的必填环境变量 | 否 |
| `npm run audit:production-database` | 经 `DATABASE_URL` 实连并验证生产会话 TLS、专用库、无管理权限、无其他业务库访问且没有 `SET ROLE` 身份切换 | 是，只读访问 PostgreSQL |
| `npm run db:migrate` | 对 `DATABASE_URL` 执行受锁保护的 PostgreSQL migration | 是，会修改指定数据库 |
| `npm run db:migrate:verify` | 在编译产物中连续执行两次受锁 migration，并要求第二次没有任何待执行项 | 是；第一次可能修改指定数据库，第二次只验证幂等结果 |
| `npm run recover:queue -- ...` | dry-run 或修复 PostgreSQL 与 Process Queue 的差异 | 是；`--apply` 会写 Queue、Outbox 与审计表 |
| `npm run observe:async` | 读取 PostgreSQL 与两个 BullMQ Queue，输出一次无内容运维快照 | 是，只读访问 PostgreSQL 与 Redis |
| `npm run test:integration:postgres` | 运行真实 PostgreSQL migration 与 Store contract tests | 是，会重建明确的 `_test` 数据库 schema |
| `npm run test:integration:async` | 运行真实 PostgreSQL、Redis、Outbox Dispatcher 与 BullMQ Worker 测试 | 是，会重建 `_test` schema 并清空指定 Redis 测试 DB |
| `npm run test:integration:async:local` | 启动隔离 Compose、运行完整异步集成测试并在成功或失败后清理 | 是，会启动并删除本地测试容器与临时数据 |
| `npm run test:drill:dispatcher-worker:local` | 启动隔离 Compose，注入 Dispatcher 重启、Worker claim 失效、重复 Job 和滚动停机故障并输出可选证据 | 是，会重建 `_test` schema、清空测试 Redis，并删除本地测试容器与临时数据 |
| `npm run test:drill:redis-rebuild:local` | 启动隔离 Compose，验证 Redis 不可用 durable acceptance、普通 relay、Queue 全丢与受审计全量重建 | 是，会重建 `_test` schema、多次清空测试 Redis，并删除本地测试容器与临时数据 |
| `npm run test:drill:webhook-observability:local` | 启动隔离 Compose，让测试 Endpoint 返回 503，验证 Process/Webhook 隔离、稳定 Event、运维快照与 staged readiness | 是，会启动本地 HTTP Endpoint、重建 `_test` schema、清空测试 Redis，并删除本地测试容器与临时数据 |
| `npm run test:acceptance:console:local` | 构建控制台并用 headless Chrome 验收浏览器异步提交、刷新恢复和终态投影 | 是，会启动并删除本地测试容器与临时数据；需要 Chrome 或 `CHROME_PATH` |
| `npm run test:acceptance:async:local` | 按 CI 顺序运行 PostgreSQL、BullMQ/跨 Seam 和浏览器三层异步验收 | 是，会启动一组隔离依赖并在结尾删除容器、网络和临时数据 |
| `npm run check:deployment:async-shape` | 用安全占位值渲染默认 Compose 与显式异步叠加层，验证角色、镜像、revision、命令、readiness、Queue 配置及缺参失败 | 否；需要 Docker Compose，不读取生产 Secret，也不启动容器 |
| `npm run smoke:agent` | 验证真实 Agent 与 Business Capability | 是，可能产生模型费用 |
| `npm run smoke:staging` | 验证已部署的受控环境 | 是 |
| `npm run smoke:async-paid-image` | 经真实网关提交固定 `crt-interface-image/v1`，验证同 key 恢复、owner GET、FAL/finalizer 与 OSS PNG | 是，产生一次图片费用并读取对象；只能由受保护 workflow 注入配置 |
| `npm run test:skill-ab` | 运行三组 Skill 对比 | 是，可能产生模型费用 |
| `npm run accept:poster-business`（`smoke:poster-process`、`test:gpt-image-2` 别名） | 从产品 `POST /execute` 验收 `minimal-zine-poster/v1`、真实图片与可选上传 | 是，可能产生模型和存储费用 |
| `npm run smoke:crt-gpt-image` | 验证一张本地参考图可通过 GPT Image 2 edit stage 生成 PNG；不运行 finalizer 或完整 Process | 是，读取本地图片、产生模型费用并写 `artifacts/` |
| `npm run accept:crt-business` | 用公网图片 URL 从产品 `POST /execute` 验收 `crt-interface-image/v1`、FAL、finalizer、可选 OSS 与证据策略 | 是，联网读取图片、产生模型/存储费用并写 `artifacts/` |
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

异步集成测试复用同一 Compose 文件，并只允许清空本机 Redis 的非零 database。首选入口为每次运行生成独立 Compose project，由 Docker 分配随机宿主端口，再把实际 PostgreSQL/Redis URL 注入 suite；它在 `finally` 中执行 `down --volumes --remove-orphans`，测试成功、失败或收到首次中断信号都会尝试清理容器与临时数据。若 Compose 清理本身失败，命令聚合主错误与清理错误，明确提示可能残留的 Docker 资源：

```bash
npm run test:integration:async:local
```

需要复用已启动的隔离依赖调试时，才分步执行：

```bash
docker compose -f compose.integration.yaml up -d --wait
export POSTGRES_TEST_DATABASE_URL=postgres://pipipi:pipipi-test-only@127.0.0.1:55432/pipipi_test
export REDIS_TEST_URL=redis://127.0.0.1:56379/15
npm run test:integration:async
docker compose -f compose.integration.yaml down
```

测试证明真实 Console Process Run Client 可经可信开发 Gateway、HTTP API、PostgreSQL Outbox、Redis、独立 Dispatcher 和 Worker 到达 `succeeded`。跨 Seam 场景会在 durable acceptance 后丢弃首次 `202`，证明 Client 用同一个幂等键获得原 `runId`、权威 Run 与受控 Capability 副作用都只有一次；它还覆盖瞬时 GET 恢复、稳定业务失败、owner/未知 Run 不可区分的 `404`，以及客户端超时后服务端继续执行并由同一 owner 恢复结果。断言只使用 Client outcome、HTTP response 和公共 Process Run 状态，不读取 SQL 布局或 BullMQ 内部字段。

最小浏览器验收从 `dist/console` 构建产物进入，使用本机 headless Chrome 和同一套隔离依赖。它延迟启动 Worker，检查页面显示 accepted `runId` 与 queued 进度、活动提交按钮被禁用、刷新后恢复同一 Run，再启动 Worker 并继续查询到结构化 `succeeded` 结果。验收记录浏览器发出的提交正文和 header，确认准确的 Process/版本/输入只提交一次，caller identity 与共享凭证只在可信测试 Gateway 内注入。受控 Content Business Capability 只返回本地确定性结果，不调用 FAL、OSS、模型或其他付费服务：

```bash
npm run test:acceptance:console:local
```

命令自动选择常见位置的 Chrome；其他 Chromium-compatible 安装通过 `CHROME_PATH=/absolute/path` 指定。该验收有意不进入默认 `npm test` 的外部依赖路径，也不对组件私有状态或大面积快照做断言。

Pull Request 和 `main` 的 `Production CI/CD` 另设稳定检查名 `Async durable acceptance`，与快速的 `Check and build` 分开运行。该 Job 在同一个隔离 Compose project 内依次执行 PostgreSQL Store contract、完整 BullMQ/跨 Seam suite 和浏览器验收；三层全部成功才允许生产 Job 继续。runner 在正常结束、失败和首次中断信号时清理，workflow 还用 `always()` 按本次 Actions run 的固定 project name 再执行幂等清理。Job 只使用仓库测试凭证和免费本地 Capability，不读取生产 Secret，也不上传失败产物。

`Async internal release` 与上述 CI 分开，只支持 `workflow_dispatch`，并绑定 `async-internal` Environment。它不重新构建候选，而是验证操作者给出的 Production CI/CD run 中 `Check and build` 与 `Async durable acceptance` 都成功，再下载该 run 的精确 commit artifact。它与默认发布共享 Actions 并发组和服务器发布锁，并使用 Environment 固定的 SSH host key。发布脚本是 [`../ops/deploy-async-internal.sh`](../ops/deploy-async-internal.sh)；workflow 只负责候选验证、受保护授权、传输和声明过的证据文件回收，远端脚本拥有门禁顺序、角色切换、信号中断恢复和候选文件清理。

`Async staged promotion` 也是独立的 `workflow_dispatch`。它下载同一 revision 的 internal release/smoke 和三项故障演练 artifact，先在 runner 上校验并汇总，再把只含非秘密门禁的单个 JSON 交给 [`../ops/promote-async-release.sh`](../ops/promote-async-release.sh)。远端脚本锁定同一发布并发域，一次只接受 `stage` 或 `traffic`，校验相邻状态、五角色 readiness、最近 critical snapshot、预算和观测窗口。stage 变化只重建 API；traffic 变化只调用服务器固定的可信网关 Adapter，四个后台角色的容器 ID 必须保持不变。失败时恢复原变量与原 promotion state。该编排是发布 Adapter，不进入 Async Process Runs 产品 Module，也不增加产品 HTTP Interface。

`Async paid image smoke` 只支持 `workflow_dispatch` 并绑定 required-reviewer 管理的 `async-paid-smoke` Environment。它要求同 revision promotion 已在 canary/production 放入至少 1% 流量、所有聚合/critical/readiness 门禁仍通过，并要求操作者输入 `APPROVE_ONE_PAID_CRT_OPERATION`、两位小数的 USD 上限和非秘密批准编号。Environment Secret 提供 caller Authorization、公网 source URL 和生产 SSH 凭证；Environment Variable 提供真实网关、批准的 OSS host/path prefix 与远端位置。它和部署/提升共用并发组，并在付费请求前核对五角色 revision、API stage 与网关实际比例。FAL 与 OSS 凭证仍只在目标 CRT Business API 的 Secret 注入中，Actions 不读取它们。

命令固定提交 `crt-interface-image/v1`、`经典`、`4:3` 和 `normal`。它以一个随机 caller-scoped idempotency key 连续发送两次完全相同的 acceptance 请求，模拟第一次响应丢失，要求两次都映射到同一 `runId`；随后结束一次查询会话，再只用相同 owner GET 恢复到终态。成功时下载最终对象并验证批准 OSS 位置、PNG、Process metadata、无 alpha 和固定调色板。artifact 只保存 revision、固定 Process identity、Run ID、终态、恢复布尔值、对象 identity/content SHA-256、尺寸/字节数和费用批准摘要，保留 90 天；不保存 source/object URL、Authorization、idempotency key、raw image、Prompt、业务 input/output、FAL/OSS Secret 或内部错误。该入口不属于 PR CI，不重试 workflow，也不提升 production 流量。

同一 suite 还证明 Outbox 在 PostgreSQL commit 后才进入统一 `process-runs` Queue，Job 只含 `schemaVersion` 和 `runId`，Worker 仍能从数据库选择准确 Registration。故障用例覆盖 Dispatcher claim 过期、Redis 断线、重复 completed Job、Worker claim 过期接管、旧 token fencing 和停机超时 release。Compose Redis 使用 `noeviction` 和临时数据目录；它只用于测试，不代表生产高可用配置。

Dispatcher/Worker 专项演练使用同一套真实依赖，但把三个跨 Seam 竞态串成一次可复现运行：Queue Job 已发布而 Outbox 未确认后的 Dispatcher 重启、过期 claim 与晚到旧 token/终态重复 Job、以及新 Worker ready 后旧 Worker grace 超时、释放 claim、Queue Recovery 重投和新 Worker 接管。它要求每个 Run 只有一条权威记录和一个公开终态 Event；受控 Capability 可以被调用多次，但以 `runId` 计的副作用只能出现一次，因此结论是“Queue 至少一次 + 下游幂等”，不是 exactly-once：

```bash
ASYNC_DISPATCHER_WORKER_DRILL_REVISION="$(git rev-parse HEAD)" \
ASYNC_DISPATCHER_WORKER_DRILL_EVIDENCE_FILE=artifacts/dispatcher-worker-drill.json \
npm run test:drill:dispatcher-worker:local
```

证据文件只含 revision、Run ID、Attempt 结果、时间线和非秘密布尔/计数观测，不含 claim token、幂等键、业务输入输出或连接地址。`.github/workflows/async-dispatcher-worker-drill.yml` 提供受保护的手动 `async-staging` 入口，固定候选 commit，在一次性 Compose project 中运行并保留证据 30 天；它不读取生产 Secret、不接生产流量，也不能提升 release stage。

Redis/Queue 重建专项演练以 PostgreSQL 为唯一事实来源：先让不可用 Queue 的普通 Dispatcher 失败，证明 Run 仍 durable queued、owner 可读且 Outbox pending；恢复普通 relay 后到达终态；再清空 Redis，制造 missing、terminal、invalid、active lease 和 pending Outbox 候选，从空 cursor 分批完成 dry-run。只有最终 cursor 为空且累计 `failed=0` 才执行 apply，最后一次 dry-run 必须得到 missing/invalid/failed 全零：

```bash
ASYNC_REDIS_REBUILD_DRILL_REVISION="$(git rev-parse HEAD)" \
ASYNC_REDIS_REBUILD_DRILL_EVIDENCE_FILE=artifacts/redis-rebuild-drill.json \
npm run test:drill:redis-rebuild:local
```

受保护入口为 `.github/workflows/async-redis-rebuild-drill.yml`，与 Dispatcher/Worker 演练共享 `async-staging` Environment 和串行并发组。

Webhook/观测专项演练在 Webhook Endpoint 持续返回 `503` 时执行两个 Process Run，要求它们在 Webhook retry window 前到达业务终态且 Process Queue 无等待；随后保存包含 Run、Outbox、两个 Queue、Delivery、storage、cleanup 和 recovery 的无内容快照。未来才到 `availableAt` 的重试必须显示为 Delivery pending，但当前 Webhook Outbox pending/lag 仍为零。Endpoint 恢复后，每条 Delivery 以同一 `eventId` 从失败 Attempt 收敛到成功 Attempt：

```bash
ASYNC_WEBHOOK_DRILL_REVISION="$(git rev-parse HEAD)" \
ASYNC_WEBHOOK_DRILL_EVIDENCE_FILE=artifacts/webhook-observability-drill.json \
npm run test:drill:webhook-observability:local
```

`.github/workflows/async-webhook-observability-drill.yml` 是受保护的手动 `async-staging` 入口；证据只保存 revision、Run/Delivery/Event ID、非秘密快照和脱敏时间线。

### 异步 HTTP 开发入口

异步路由默认关闭。启用时以下配置必须作为一个完整配置组提供：

- `ASYNC_PROCESS_RUNS_ENABLED=true` 与已完成 migration 的 `DATABASE_URL`；
- `ASYNC_RELEASE_STAGE=internal|canary|production`；
- 至少 32 bytes 的 `ASYNC_GATEWAY_SHARED_SECRET`；
- `PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS`、`PROCESS_RUN_RESULT_RETENTION_MS` 和 `PROCESS_RUN_METADATA_RETENTION_MS`；
- `ASYNC_GLOBAL_BACKLOG_LIMIT`、不高于它的 `ASYNC_CALLER_BACKLOG_LIMIT` 和 `ASYNC_BACKLOG_RETRY_AFTER_SECONDS`；
- 可选的 PostgreSQL Pool、连接超时、claim lease、轮询 `Retry-After` 与 staged readiness 阈值。

可信网关必须先验证 service principal，删除外部请求中的 `x-pipipi-caller-id` 和 `x-pipipi-gateway-token`，再分别注入稳定 subject 与共享凭证。应用不接受请求 body 中的 owner，也不把身份头、共享凭证或数据库错误写入响应。`GET /healthz` 始终只做 liveness；`GET /readyz` 在异步功能启用时检查包括 backlog admission 索引在内的数据库 migration，`canary` 与 `production` 还检查 backlog、stuck Run、已到期 Outbox lag 和最近一次从空 cursor 到最终空 `nextCursor` 的完整成功人工全量恢复链。

`ASYNC_PROCESS_RUN_INTAKE_DISABLED_FILE` 是服务端运维 Seam：marker 不存在时接受新 Run，存在时只有 `POST /process-runs` 返回 `503 ASYNC_INTAKE_CLOSED`；owner GET 和同步 `/execute` 继续工作。生产 Compose 把它固定到只读挂载的 `/var/lib/pipipi-async-control/intake-disabled`，调用方不能通过请求改变。`npm run smoke:async-internal` 由受保护 workflow 分 baseline/rollback 两阶段调用，外部请求正文和操作者凭证只从 Environment Secret 读取，不进入日志或证据。

本地浏览器只能通过 Vite 的开发 Gateway 调用异步路由。显式设置 `CONSOLE_DEVELOPMENT_GATEWAY_ENABLED=true`、本机 HTTP `CONSOLE_DEVELOPMENT_GATEWAY_TARGET` 和与 API 相同的 `ASYNC_GATEWAY_SHARED_SECRET` 后，`npm run dev:console` 才挂载 `/process-runs` 代理。Adapter 删除浏览器提供的两个身份头，再注入固定的 `console:development` 和共享凭证；凭证不使用 `VITE_` 前缀，不进入 bundle、storage、响应或日志。该入口拒绝 build、非 `development` mode、`NODE_ENV=production` 和非 loopback target，不能替代生产认证网关。

当前已验证提交、查询、Outbox 调度、BullMQ Worker、故障恢复、容量门禁、独立角色、结构化关联日志和运维快照。配置齐全不等于可以直接开放；外部生产流量必须按 [`async-process-runs-runbook.md`](async-process-runs-runbook.md) 完成安全审查、故障演练和 staged rollout。

### 异步运行角色

同一构建产物还提供 `npm run start:business-api`，负责内部 `POST /crt-images`、FAL、finalizer 和 OSS。它与 API 作为独立进程或工作负载运行；单服务器 Compose 只把它绑定到宿主机回环地址。`compose.production.async.yaml` 是必须与 `compose.production.yaml` 一起使用的显式叠加层：它启用 API，并以同一镜像分别启动 Dispatcher、Worker、Webhook Worker 和 Retention Cleaner。每个角色先运行自己的环境预检，再启动自己的入口，并用独立端口的 `/readyz` 作为容器健康检查。该文件不包含 PostgreSQL 或 Redis，也不改变默认同步形状。`npm run start:operations` 是一次性运维 Job；`ASYNC_PROCESS_RUNS_ENABLED` 只控制 API 是否公开异步路由。

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

各长运行角色都提供 `GET /healthz` 和 `GET /readyz`。liveness 只确认进程工作；异步角色的 readiness 检查实际使用的 migration、PostgreSQL 和 Redis。CRT Business API 的启动校验负责检查配置形状，readiness 不产生 FAL 或 OSS 请求。默认同步 API 保持原样，启用异步路由也不会删除 `POST /execute`。

`npm run observe:availability` 是一次性 Availability Monitor Job。它从服务器侧检查公网网关、回环 Business API、可选的四个异步角色和 Redis；Module Interface 只返回脱敏的固定报告，飞书 V2 自定义机器人 Adapter 只在 `degraded` 或 `unavailable` 时发送文本告警，并要求 HTTP 200 与响应 `code=0` 同时成立。开发测试通过注入内存 HTTP、Redis 与 Webhook Adapter 验证同一个 Interface，不访问真实服务。生产应从已构建镜像运行 `node dist/bin/availability-monitor.js`，调度周期由外部受信 timer/Job 拥有。

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

成功日志只保留关联元数据：API/Worker 用 `runId`，Process Attempt/activity 另有 `attemptNumber + sequence`，Outbox 用 `messageId + eventId + runId|deliveryId`，Webhook Attempt 用 `deliveryId + eventId`。日志不得包含 idempotency key、accepted input、output、Prompt、Tool 参数、模型消息、Webhook URL/payload、Secret 或内部异常正文。精确部署、告警处置和 fault drill 见 [`async-process-runs-runbook.md`](async-process-runs-runbook.md)。

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
| `src/bin/` | API、CRT Business API、Dispatcher、Worker、Cleaner、Operations、Recovery 和 Availability Monitor 的可执行入口；不放业务规则 |
| `src/app/` | 各可执行角色的 Composition Root、启动配置和后台角色生命周期 |
| `src/api/` | HTTP Application、路由和 caller identity；不组装业务与基础设施 |
| `src/process-runtime/` | 跨 Business Process 复用的 Registration、Registry、Runner、Attempt、结果和观测治理 |
| `src/agent-runtime/` | 跨 Business Process 复用的 Pi provider 配置、无 Tool Structured Agent Session、Agent JSON 解析、Installed Skill Catalog 和 Runtime Skill 精确加载 |
| `src/processes/` | production catalog，以及按 `content/`、`titled-content/`、`poster/`、`crt/`、`news-image/` 分组的具体 Business Process；不放通用 Runtime |
| `src/process-runs/` | Async Process Runs，以及按 `store/`、`queue/`、`outbox/`、`worker/`、`recovery/`、`retention/` 和 `ops/` 分组的内部 Module |
| `src/webhooks/` | Webhook Delivery，以及按 `delivery/`、`store/`、`queue/`、`outbox/` 分组的内部 Module |
| `src/availability/` | 一次性 Availability Monitor、HTTP/Redis Probe 和异常 Webhook Notifier |
| `src/network/` | 跨 Adapter 复用的公网地址校验、DNS 解析与 IP-pinned HTTP transport；不拥有业务重试或 payload 语义 |
| `src/business-api/` | CRT Business API、FAL、finalizer、证据和对象存储 Adapter |
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
| `src/app/availability-monitor.ts` | Availability Monitor 的 Probe、Notifier 与部署配置组装 |
| `src/network/public-http.ts` | 公网目标校验、全部 DNS 地址检查、固定 IP 连接和有界响应读取 |
| `src/process-runtime/` | Registration、Registry、同步 Runner、Attempt Runner、运行活动日志、Run Record、公共结果和错误治理 |
| `src/agent-runtime/catalog.ts`、`pi.ts`、`skills.ts`、`structured.ts` | 多个流程共用的启动期 Skill 完整性与版本 Catalog、Pi provider 配置、Runtime Skill 精确加载，以及海报、CRT 与新闻图片共用的无 Tool Structured Agent Session |
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

依赖方向固定为：`bin` 只进入 `app`；`app` 组装 `api`、`processes`、`process-runs` 和 `webhooks`；具体 `processes` 依赖 `process-runtime` 与 `agent-runtime`，`api` 和 `process-runs` 只依赖 `process-runtime` 的稳定 Interface。Runtime Module 不反向引用具体 Business Process，领域与业务 Module 不反向引用 `app` 或 `bin`；Composition Root 负责把它们连接起来。

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

1. 新建 `create…Registration` factory，通过 `defineProcessRegistration` 声明固定 `id`、`version`、输入 Schema、输出 Schema、运行活动和 Process Definition。
2. 把该流程获准使用的窄 Business Capability 和稳定策略传给 factory，并由闭包捕获。流程使用 Agent 时，在流程 Module 内定义准确、有序的 Skill 与 Tool 集合；Composition Root 只提供 Adapter 和部署配置。Execution Context 只携带 `runId`、`AbortSignal` 和受控 `runActivity` 等请求级信息。
3. 用 `failProcess` 返回预期的 `AGENT_FAILURE` 或 `DEPENDENCY_FAILURE`。让意外异常继续抛出，由 Process Runner 转换为安全的 `INTERNAL_ERROR`。
4. 在 `createProcessExecutor` 的显式 production catalog 中加入 Registration。每项只代表一个准确 `(id, version)`。
5. 通过 Registration Seam 测试接受、JSON 往返、单次解析、策略和输出。Agent 流程还要验证 Tool 调用次数、下游幂等键和最终结果来源；通过 Process Attempt Runner 测试预分配 `runId`、超时、活动时间线、日志故障隔离与错误净化；通过真实本地 `/execute` 测试产品行为和 HTTP 映射。
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

## 追踪 Process Run 活动

Production Composition Root 默认通过 Pino Adapter 把 Process Attempt 与活动日志写成 newline-delimited JSON。Process author 在 Registration 中声明固定活动，并用 Execution Context 包住有业务意义、可能耗时或失败的操作：

```ts
return defineProcessRegistration({
  id: "example-processing",
  version: "v1",
  inputSchema,
  outputSchema,
  activities: ["policy_loading", "content_processing"],
  execute: async (input, context) => {
    const policy = await context.runActivity("policy_loading", () => loadPolicy());
    return context.runActivity("content_processing", () => process(input, policy));
  },
});
```

活动名必须是最多 64 个字符的小写 snake case，列表最多 32 项且不能重复。名称必须由代码固定，不能拼接 input、资产标识、URL、供应商响应或其他运行时内容。`runActivity` 自动记录 start/finish、`succeeded|failed|cancelled` 和耗时；Attempt finish 记录 `succeeded|failed|timed_out|cancelled` 与可选公开错误码。异步 Worker 传入持久化 Attempt number，同步执行固定为 1。

按 `runId` 筛选日志，再按 `attemptNumber` 和 `sequence` 排序即可还原执行时间线。`sequence` 只在单个 Attempt 内递增；跨 Attempt、实例或 Process Run 不承诺全局顺序。Pino 添加数值 `level`、`pid`、`hostname`、`service`、`module` 和 `msg`；事件自己的 ISO `timestamp` 是唯一时间字段。started 与成功 finish 使用 `info`，失败或取消使用 `warn`，以 `INTERNAL_ERROR` 结束的失败 Attempt 使用 `error`。

`PROCESS_RUN_LOG_LEVEL` 控制 Pino 阈值，默认 `info`，可设为 `fatal|error|warn|info|debug|trace|silent`。设为 `warn` 时只输出失败、取消和超时；设为 `silent` 时关闭 Process Run 活动日志。日志 sink、Pino destination 或时钟失败不会改变 Process Result。日志不保存 accepted input、output、Prompt、Tool 参数、模型消息、隐藏推理、Secret、远端正文或内部异常消息。Pino redaction 是敏感字段名的兜底保护，不能替代 `ProcessRunLogRecord` 的源头白名单。

运行活动日志是 best-effort 观测，不是权威 Process Event、状态库、Run Record 或产品查询 Interface。需要可靠状态与结果时，异步调用方仍查询 owner-scoped `GET /process-runs/{runId}`；需要业务审计时，应设计独立的授权、持久化和保留策略。

## 接入 Run Record

默认生产构造使用 disabled 实现，只输出结构化 Attempt 与活动日志。开发或单实例测试可以注入有容量上限的内存实现：

```ts
import { createProcessingApplication } from "./src/api/application.js";
import { createProcessExecutor } from "./src/processes/catalog.js";
import { createInMemoryProcessRunRecords } from "./src/process-runtime/records.js";

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

部署预检必须在 `npm run build` 后、每个角色自己的环境变量和 Secret 已注入时运行：

```bash
npm run check:deployment-env -- api
```

可选角色为 `api`、`crt-business-api`、`process-dispatcher`、`process-worker`、`webhook-worker`、`retention-cleaner`、`async-operations` 和 `process-recovery`。命令检查该角色无默认值的必填项，空字符串和纯空白都视为缺失；Agent 角色和 CRT Business API 还检查各自供应商凭证名称。命令不会连接 PostgreSQL、Redis、模型、OSS 或 Business Capability，也不会输出配置值。每个 Construction Root 会在创建 Adapter 前重复基础检查，再由原有解析器校验 URL、数值、枚举和跨字段约束。

- 新增配置时同时更新 `.env.example`、启动构造测试和相关文档。
- 只把稳定运行策略放入环境配置。Process 拓扑、Schema 和业务语义留在代码中。
- 成组配置在启动时一起校验。例如 `PI_PROVIDER` 与 `PI_MODEL` 必须同时设置。
- 异步功能关闭时忽略数据库和网关专用配置；启用后缺少任一必需值都在监听前失败。
- `CONTENT_PROCESSING_MODE=direct` 只关闭文本 Agent；`minimal-zine-poster/v1` 与 `crt-interface-image/v1` 始终使用 Agent，因此共享的 Pi provider、model 和 API mode 仍须有效。
- `POSTER_API_TIMEOUT_MS` 只控制受控 `POST /posters` Adapter，默认 `90000`；Process 总超时仍由 `PROCESS_TIMEOUT_MS` 治理。
- `CRT_API_TIMEOUT_MS` 只控制受控 `POST /crt-images` Adapter，默认 `180000`。受控发布必须让 `PROCESS_TIMEOUT_MS` 长于它，平台请求超时再长于 Process 总超时。
- `IMAGE_PROVIDER=openai|fal` 选择真实图片集成 Adapter，默认 `openai`。OpenAI Adapter 可用 `OPENAI_IMAGE_API_KEY` 与 `OPENAI_IMAGE_BASE_URL` 脱离 Agent 网关；未设置时回退到 `OPENAI_API_KEY` 与 `OPENAI_BASE_URL`。FAL Adapter 只读取服务端 `FAL_KEY`，并固定调用 GPT Image 2 生成与编辑 endpoint。
- `INTERNAL_EVAL_ENABLED=true` 只在受控测试或内部环境挂载 `POST /internal/eval/execute`。该入口仅接受三个新闻图片 Process，复用正式 Executor、Registration、Agent 和图片 Capability，在同一次成功执行中返回实际 Prompt、文本模型与非敏感图片参数。响应使用 `no-store`，诊断内容不进入正式输出、日志或 Run Record；生产 Compose 固定关闭。
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
- HTTP Adapter 测试传输错误、容量、状态码和请求级结构化日志；Process Attempt Runner 测试运行活动日志。
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
