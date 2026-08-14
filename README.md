# Business Processing Service

一个轻量的版本化业务处理服务。产品调用方只提交 Business Process、准确版本和业务输入；服务端用代码绑定 Schema、业务行为、获准依赖和稳定策略。流程内部可以使用本地逻辑、远程 Business Capability 或受限 Agent，产品契约不随实现方式变化。

## 当前能力

生产 catalog 包含七个 Business Process：

| Process | 输入 | 输出 |
| --- | --- | --- |
| `content-processing/v1` | `{ "content": string }` | `{ "content": string }` |
| `titled-content-processing/v1` | `{ "title": string, "body": string }` | `{ "title": string, "content": string }` |
| `minimal-zine-poster/v1` | `{ "brief": string, "text"?: string }` | `{ "prompt", "recipe", "interpretation", "image" }` |
| `crt-interface-image/v1` | `{ "sourceImageUrl", "palette", "aspectRatio" }` | `{ "aspectRatio", "image" }` |
| `news-image-narrative-monument/v1` | `{ "title", "summary" }` | `{ "style", "image" }` |
| `news-image-pale-watercolor/v1` | `{ "title", "summary" }` | `{ "style", "image" }` |
| `news-image-raw-humanism/v1` | `{ "title", "summary" }` | `{ "style", "image" }` |

七个流程共享同一个 `POST /execute` Interface。每个明确版本由 Process Registration 绑定业务定义、Schema、依赖、运行活动和策略，再进入不可变 Process Registry。Process Runner 统一处理 `runId`、精确版本查找、超时、取消、错误净化和可选 Run Record。

每个实际开始的 Process Attempt 都通过 Pino 输出无业务内容的单行 JSON 活动日志。运维系统可按 `runId`、`attemptNumber` 和 `sequence` 还原 Attempt 开始、固定活动开始/结束和 Attempt 结果；活动结束记录包含结果与耗时。日志不保存 input、output、Prompt、Tool 参数、模型消息或内部异常正文。

启用记录后，每次终态执行还会作为 Run Record 持久化，同一存储里还保存 Attempt 活动归档。stdout 的 Pino 活动日志随容器重建消失，这份归档不会，因此可以按 `runId` 还原完整的 Attempt 与活动时间线——每步活动、结果和耗时。`PROCESS_RUN_RECORD_STORE` 选择存储：生产用 `postgres`（有备份，聚合是查询），本地开发用 `file`（按 UTC 日期分文件的 JSONL，不依赖数据库）。两个实现通过同一套契约测试。日志随容器重建而消失，Run Record 写在宿主机卷上，因此跨发布保留。`PROCESS_RUN_RECORD_CONTENT=accepted-input-and-output` 时记录附带已校验输入与成功输出，`crt-interface-image` 的 `sourceImageUrl` 始终只保存 SHA-256 摘要。`CONSOLE_ENABLED=true` 时，API 在 `CONSOLE_BASE_PATH`（默认 `/console`）挂载运维控制台：按 `runId` 检索并回看输入、产出图片与完整活动时间线；按 Process 和状态筛选历史；查看窗口内的执行计数、失败分布、Attempt 耗时分位数与实时并发占用；查看由 Registration Schema 推导的 Process 目录；以及异步提交任务并查询结果。控制台通过独立的 Process Run Client Interface 校验提交和查询响应，只向页面公开结构化进度、终态、公开错误、结果过期、查询超时、客户端取消、未确定接受、可重试 admission、恢复冲突、恢复存储不可用和协议错误；跨源或错误形状的结果地址不会被查询。Client 在首次 POST 前持久化请求摘要、幂等键和恢复分类，响应丢失、可重试 admission 或刷新恢复时复用同一 key；未确定或可重试操作只有在明确的新提交时才生成新 key。浏览器恢复状态不保存业务输入或输出。accepted Run 默认等待 300 秒；有效 `Retry-After` 限制在 1–30 秒，缺失或无效时使用有界指数退避。瞬时 GET 故障在期限内恢复；等待超时、Abort 或关闭页面只停止客户端 transport、timer 与 polling，不取消服务端 Run。页面是 Preact + Vite 构建的单页应用，与 API 同源提供，构建工具只在 devDependencies，不进入运行时容器。控制台没有自带鉴权，且表单会真实触发付费出图；上线前的访问控制要求见 [`docs/mvp-release-runbook.md`](docs/mvp-release-runbook.md#运维控制台)。

恢复记录使用 tab-scoped `sessionStorage`，只跨同一标签页刷新保留，不在标签页之间共享。accepted 映射不能被新提交覆盖；操作者必须先继续查询到终态，或明确移除恢复记录。Storage 不可用时页面禁止提交。可信网关还必须保证一个控制台标签页内 caller session 稳定；切换 caller 前先处理或移除恢复记录。

`content-processing/v1` 的 Agent 路径会同时加载服务端固定的 `content-optimization` 和 `content-integrity`。两项 Skill 作为一个经过评审的指令集执行，但仍只获得 `process_business_content` Tool。Registration 只接受一次 Tool 调用，并要求 Agent 最终结果与 Tool 结果一致；调用方不能提交或覆盖 Skill。

`minimal-zine-poster/v1` 固定加载 `minimal-zine-poster-prompt`。这个 Runtime Skill 只把 brief 编译成四段 Prompt 和六轴 recipe，不获得任何 Tool。Registration 校验 Prompt、recipe 和可选原文后，以 `runId` 为幂等键调用一次 Poster Rendering Capability。Capability 返回 HTTP(S) 图片 URL、类型和尺寸；原始图片字节不进入 `/execute` JSON。

`crt-interface-image/v1` 把服务端资产标识、调色板和画幅收敛为参考图转换。无 Tool Agent 固定加载 `tait-crt-interface-prompt`，只编译内部 Prompt 和十四轴 recipe；Registration 校验后，以 `runId` 为幂等键调用一次 CRT Rendering Capability。产品输出只返回画幅和 PNG 引用，不返回 Prompt、recipe、模型、Skill 或源图片字节。完整开发契约和上线门禁见 [`docs/processes/crt-interface-image/`](docs/processes/crt-interface-image/)。

三个新闻图片 Process 都接收标题和摘要，并分别固定人物叙事碑式封面、淡彩绘本和原质人文主义 Runtime Skill。Registration 校验后调用同一个受控图片 Capability，生成并持久化 1600×1200 PNG。调用方不能选择 Skill、模型或图片供应商。

## 按 Business Process 查看

每个 production Process 都有独立文档目录。先从对应目录确认产品契约、执行顺序、依赖、错误和验证入口，再进入 Implementation：

| Process | 独立文档 | 主要 Registration |
| --- | --- | --- |
| `content-processing/v1` | [`docs/processes/content-processing/`](docs/processes/content-processing/) | [`src/processes/content/registration.ts`](src/processes/content/registration.ts) |
| `titled-content-processing/v1` | [`docs/processes/titled-content-processing/`](docs/processes/titled-content-processing/) | [`src/processes/titled-content/registration.ts`](src/processes/titled-content/registration.ts) |
| `minimal-zine-poster/v1` | [`docs/processes/minimal-zine-poster/`](docs/processes/minimal-zine-poster/) | [`src/processes/poster/registration.ts`](src/processes/poster/registration.ts) |
| `crt-interface-image/v1` | [`docs/processes/crt-interface-image/`](docs/processes/crt-interface-image/) | [`src/processes/crt/registration.ts`](src/processes/crt/registration.ts) |
| `news-image-narrative-monument/v1` | [`docs/processes/news-image-narrative-monument/`](docs/processes/news-image-narrative-monument/) | [`src/processes/news-image/registration-narrative-monument.ts`](src/processes/news-image/registration-narrative-monument.ts) |
| `news-image-pale-watercolor/v1` | [`docs/processes/news-image-pale-watercolor/`](docs/processes/news-image-pale-watercolor/) | [`src/processes/news-image/registration.ts`](src/processes/news-image/registration.ts) |
| `news-image-raw-humanism/v1` | [`docs/processes/news-image-raw-humanism/`](docs/processes/news-image-raw-humanism/) | [`src/processes/news-image/registration-raw-humanism.ts`](src/processes/news-image/registration-raw-humanism.ts) |

总目录和新 Process 的放置规则见 [`docs/processes/README.md`](docs/processes/README.md)。production catalog 的准确清单由 [`src/processes/catalog.ts`](src/processes/catalog.ts) 和 [`src/app/business-processes.ts`](src/app/business-processes.ts) 决定。

产品请求只有业务字段：

```json
{
  "process": "minimal-zine-poster",
  "version": "v1",
  "input": {
    "brief": "为雨天旧书店做一张安静的海报",
    "text": "PIPIPI ZINE"
  }
}
```

成功输出中的 `recipe` 固定包含 `layout`、`anchor`、`typography`、`accent`、`texture` 和 `mood`；`image` 包含 `url`、`contentType`、`width`、`height`，短期 URL 还包含 `expiresAt`。

## 快速开始

需要 Node.js 24 或更高版本。

```bash
npm install
cp .env.example .env
```

`.env` 已被 Git 忽略。文本 Direct 路径不调用模型；执行海报业务验收、文本 Agent 路径或真实模型 smoke 时需要模型凭证。不要把真实凭证提交到仓库。

构建部署产物后，可在目标角色的 Secret 注入环境中运行 `npm run check:deployment-env -- api`，一次检查全部无默认必填项。异步角色名和逐角色清单见 [同步 MVP 发布手册](docs/mvp-release-runbook.md#部署环境预检) 与 [异步发布手册](docs/async-process-runs-runbook.md#配置与分阶段启用)。实际启动会重复存在性检查，再校验格式和跨字段约束。

`compose.production.yaml` 始终是关闭异步入口的默认单服务器形状。经发布门禁批准后，运维人员才可显式叠加 `compose.production.async.yaml`，用同一不可变镜像启动 API、Process Dispatcher、Process Worker、Webhook Worker 和 Retention Cleaner；PostgreSQL 与 Redis 必须由部署环境外部提供。`npm run check:deployment:async-shape` 可在不读取生产 Secret 的情况下验证合并后的形状与缺参失败行为。

`.github/workflows/async-internal-release.yml` 是唯一自动化异步启用入口，只能手动触发并绑定受保护的 `async-internal` Environment。它只接受精确 commit 与对应 CI run，复用 CI 构建的 release artifact，固定发布为 `internal`；逐角色预检、migration 双跑、全量 Queue Recovery dry-run、后台 readiness 和 revision/Queue 核验全部通过后才启动 API。同步与异步发布共享 Actions 并发组、服务器锁和固定 SSH host key；失败或信号中断会恢复上一形状。只回传声明过的非秘密证据文件，流程不会自动提升到 canary 或 production。

internal 发布后可手动运行受保护的 `.github/workflows/async-internal-smoke.yml`。它通过真实 HTTPS 网关验证成功、稳定业务失败和双 caller owner 隔离，收集角色状态、Async Operations、数据库保留信号与按 Run 关联的脱敏日志；随后用服务端 marker 只关闭新异步 intake，证明既有 owner GET 和同步 `/execute` 仍可用，再自动恢复 intake。请求正文、操作者凭证和幂等键不进入证据；该 workflow 同样不会自动提升流量。

同一候选的 internal release/smoke、Dispatcher/Worker、Redis 重建和 Webhook/观测证据全部成功后，受保护的 `.github/workflows/async-promote-release.yml` 才允许逐次执行 `internal/0% → canary/0% → 1% → 5% → 25% → production/25% → 50% → 100%`。每次人工批准只改变 stage 或可信网关流量中的一个变量；五个角色 readiness、容量/费用和 critical alert 在变更前后任一失败都会恢复原值。应用不拥有网关路由，服务器上的固定 Adapter 只向该 workflow 提供当前比例、设定比例和无内容 critical snapshot。

在第一个终端启动演示 Business Capability：

```bash
npm run dev:business-api
```

文本演示服务只实现 `POST /process`。海报 Process 仍要求 `BUSINESS_API_BASE_URL` 指向实现 `POST /posters` 的受控服务；CRT 与新闻图片 Process 通过 `CRT_BUSINESS_API_BASE_URL` 使用仓库提供的内部图片 Business API。全部产品调用契约见 [`docs/api.md`](docs/api.md)。

在第二个终端启动处理服务：

```bash
npm run dev
```

执行 `content-processing/v1`：

```bash
curl -X POST http://127.0.0.1:3000/execute \
  -H 'content-type: application/json' \
  -d '{
    "process": "content-processing",
    "version": "v1",
    "input": { "content": "  launch   offer  " }
  }'
```

成功响应包含独立 `runId` 和经过处理的结构化输出：

```json
{
  "runId": "...",
  "process": "content-processing",
  "version": "v1",
  "status": "succeeded",
  "output": { "content": "Processed: launch offer" }
}
```

健康检查：

```bash
curl http://127.0.0.1:3000/healthz
```

`GET /healthz` 只确认进程完成初始化，不访问模型或 Business Capability。

`GET /readyz` 表达当前角色所需依赖是否就绪；默认同步形状不访问外部依赖。启用异步入口后会检查包括 backlog admission 索引在内的 PostgreSQL migration，`canary` 与 `production` 阶段还检查容量、stuck Run、已到期 Outbox 延迟和最近一次完整成功的人工全量恢复批次链。

## 异步开发 Interface

仓库已提供资源式的 `POST /process-runs` 和 `GET /process-runs/{runId}`。它要求网关验证身份、注入固定 caller 头与共享凭证，并要求每次提交携带 `Idempotency-Key`。成功提交返回 `202`、`Location`、`Retry-After` 和 queued Run；查询只向 owner 返回 queued、running、succeeded 或 failed。结果内容到期后，终态和完成时间仍在 metadata 保留期内可查，并返回 `resultAvailability: "expired"` 与 `resultExpiredAt`，不会把内容缺失伪装成空结果。

运维可通过服务端只读 marker 暂停新异步提交；此时 POST 返回 `503 ASYNC_INTAKE_CLOSED`，但既有 owner 查询和同步 `/execute` 保持可用。完整产品契约见 [`docs/api.md`](docs/api.md#异步执行)，操作步骤见[异步发布手册](docs/async-process-runs-runbook.md#真实网关-smoke-与安全回滚)。

本地开发可显式启用 Vite-only Gateway：它只代理到 loopback API，删除浏览器伪造的身份头，再注入固定 `console:development` 身份和服务端持有的共享凭证。build 与生产 mode 无法启用该 Adapter。`npm run test:integration:async:local` 会启动隔离 PostgreSQL/Redis，运行 Console Client → Gateway → API → Dispatcher → Worker 的真实成功链；`npm run test:acceptance:console:local` 进一步从 `dist/console` 启动 headless Chrome，覆盖提交防重、accepted 进度、刷新恢复和结构化终态。三个专项入口分别验证 Dispatcher/Worker 竞态、Redis/Queue 全丢重建，以及 Webhook 503 不影响 Process 终态与 Queue latency；Webhook 演练还校验 staged readiness、critical 观测信号和脱敏关联证据。所有本地入口都在成功或失败后删除容器和临时数据，且不调用付费 Capability；配置与判据见[开发指南](docs/development.md#postgresql-与-redis-异步集成测试)。

该 Interface 由 `ASYNC_PROCESS_RUNS_ENABLED=true` 显式启用，默认关闭，并要求明确的 `internal`、`canary` 或 `production` 阶段。仓库已经实现 transactional Outbox、相互隔离的 Process/Webhook BullMQ Queue、租约恢复、Queue 重建、容量门禁、运维快照和有期限停机。新提交在 durable backlog 达到 caller 上限时返回 `429`，达到全局上限时返回 `503`，两者都带 `Retry-After`；既有 Run 查询不受 admission 影响。完整契约见 [`docs/async-process-runs-design.md`](docs/async-process-runs-design.md)，受控发布步骤见 [`docs/async-process-runs-runbook.md`](docs/async-process-runs-runbook.md)。

## Interface 约束

- 调用方必须请求准确的 Process 和版本。未注册版本返回 `PROCESS_NOT_FOUND`。
- 输入严格按该版本的 Schema 校验。无效输入返回 `INVALID_INPUT`。
- 依赖、Agent、输出和超时失败分别返回稳定的公开错误，不透传内部消息。
- 非 JSON、请求体过大和实例容量已满分别返回 `UNSUPPORTED_MEDIA_TYPE`、`REQUEST_TOO_LARGE` 和 `SERVICE_BUSY`。
- 调用方不能上传流程步骤、脚本、模型、Skill、Tool 或远程地址。
- 当前同步入口默认不持久化 Run Record。结构化活动日志也不是权威状态或产品查询 Interface；异步入口使用独立的权威 Process Run Store。两种入口都不把 `runId` 当作聊天会话 ID。

## 当前边界

默认发布仍是受控、同步、无状态的 MVP。部署平台必须提供 TLS、私有入口、调用方认证、Secret 注入和实例上限。异步实现具备独立的受控 `internal` 发布与 staged promotion 入口，但普通主分支发布不会启用或提升异步流量；发布人员必须按异步 Runbook 完成 migration、身份、容量、恢复、安全、观测和逐级人工授权。当前发布不提供应用用户系统、RBAC、多租户、CORS、通用幂等或动态流程注册。

仓库内已有 Async Process Runs Module、事务化 PostgreSQL Store、Process/Webhook Outbox，以及相互隔离的 BullMQ Process Queue 和 Webhook Queue。`npm run start:api`、`npm run start:dispatcher`、`npm run start:worker`、`npm run start:webhook-worker` 和 `npm run start:retention-cleaner` 从同一构建产物启动独立角色；显式异步生产叠加层为每个角色执行环境预检并用独立 readiness 端口探测。Process 默认只执行一次，只有服务端 Registration 明确声明安全错误、次数和退避时才会重试；Webhook 已支持精简终态事件、Standard Webhooks 签名、PostgreSQL 权威的有界重试、Attempt 审计、受控人工重放、加密 Secret 和防 SSRF 的固定目标连接。Retention Cleaner 按固定 cutoff 分批删除到期内容，批次审计和返回游标允许安全续跑。Redis Queue 丢失时，`npm run recover:queue` 默认先做 PostgreSQL 权威的 dry-run，再由运维人员显式 `--apply` 重建所有仍需执行的 Job；终态 Run 永不进入恢复候选。`npm run observe:async` 从 PostgreSQL 和两个 Queue 读取不含业务内容的运维快照，Dashboard/alert 字段固定在 `ops/async-observability.json`。

`minimal-zine-poster/v1` 和 `crt-interface-image/v1` 已进入 production catalog，但生产 Adapter 只依赖受控 Business API 的 `POST /posters` 与 `POST /crt-images`，不把 FAL、OSS 或模型参数暴露给产品调用方。生产 Compose 已包含内部 CRT Business API；海报 Business API 仍由部署方提供。付费图片与 OSS 验收必须显式运行，不进入默认测试。当前海报版本不接收参考图片；CRT 版本接收公网 HTTPS `sourceImageUrl`。两者都不执行自动看图质检或重绘。

CRT 流程的 Registration、Runtime Skill、HTTP Adapter、内部 Business API、FAL URL 编辑、独立 finalizer 和 OSS 输出已经完成。正式发布仍需确认：内部 `POST /crt-images` 不向公网暴露，来源 URL 可由 FAL 读取，目标环境完成存储验收，生产证据保留关闭，并确认上游 Skill 的再分发和生产使用权。

## 文档导航

| 文档 | 面向谁 | 回答什么 |
| --- | --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | 产品与开发者 | 项目目的、范围、信任模型和共同语言 |
| [`docs/README.md`](docs/README.md) | 所有维护者 | 文档索引、分类和维护规范 |
| [`docs/api.md`](docs/api.md) | 产品调用方 | 全部业务调用路由、Process 入参、响应和错误 |
| [`docs/development.md`](docs/development.md) | 开发者 | 本地开发、代码地图、改动路径和验证要求 |
| [`docs/authoring-business-processes.md`](docs/authoring-business-processes.md) | 产品与开发者 | 如何把自然语言流程描述封装为版本化 Business Process |
| [`docs/processes/README.md`](docs/processes/README.md) | 产品与开发者 | 每个 production Business Process 的独立文档入口 |
| [`docs/integrating-runtime-skills.md`](docs/integrating-runtime-skills.md) | 开发者 | 如何从本地路径或远程来源审查、固定并接入 Skill |
| [`docs/process-runtime-design.md`](docs/process-runtime-design.md) | 开发者 | Module、Interface、执行 invariant 和错误归属 |
| [`docs/async-process-runs-design.md`](docs/async-process-runs-design.md) | 开发者 | 异步提交、持久化查询、BullMQ Worker 和 Webhook 设计 |
| [`docs/async-process-runs-development-plan.md`](docs/async-process-runs-development-plan.md) | 开发者 | 异步能力的开发批次、测试门槛和发布顺序 |
| [`docs/async-process-runs-runbook.md`](docs/async-process-runs-runbook.md) | 发布与运维人员 | 异步 migration、容量、观测、故障演练、灰度与回滚 |
| [`docs/experiments.md`](docs/experiments.md) | 开发者 | Agent、Skill、图片与对象存储的真实集成验证 |
| [`docs/mvp-release-runbook.md`](docs/mvp-release-runbook.md) | 发布与运维人员 | 受控 Business Process MVP 的部署门禁、验收和回滚 |

先读 [`CONTEXT.md`](CONTEXT.md) 建立项目语境；准备改代码时再读 [`docs/development.md`](docs/development.md)。
