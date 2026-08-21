# Business Processing Service

一个轻量的版本化业务处理服务。产品调用方只提交 Business Process、准确版本和业务输入；服务端用代码绑定 Schema、业务行为、获准依赖和稳定策略。流程内部可以使用本地逻辑、远程 Business Capability 或受限 Agent，产品契约不随实现方式变化。

## 当前能力

生产 catalog 登记八个 Business Process，其中 `composed-task/v1` 默认关闭。文档先按产品场景分组，运行时仍通过统一的 Process identity 和 HTTP Interface 执行：

| 场景 | Process | 输入 | 输出 |
| --- | --- | --- | --- |
| `common` | `content-processing/v1` | `{ "content": string }` | `{ "content": string }` |
| `common` | `titled-content-processing/v1` | `{ "title": string, "body": string }` | `{ "title": string, "content": string }` |
| `common` | `minimal-zine-poster/v1` | `{ "brief": string, "text"?: string }` | `{ "prompt", "recipe", "interpretation", "image" }` |
| `common` | `crt-interface-image/v1` | `{ "sourceImageUrl", "palette", "aspectRatio" }` | `{ "aspectRatio", "image" }` |
| `memene` | `news-image-narrative-monument/v1` | `{ "title", "summary" }` | `{ "style", "image" }` |
| `memene` | `news-image-pale-watercolor/v1` | `{ "title", "summary" }` | `{ "style", "image" }` |
| `memene` | `news-image-raw-humanism/v1` | `{ "title", "summary" }` | `{ "style", "image" }` |
| `common` | `composed-task/v1`（默认关闭） | `{ "goal", "material"?, "constraints"? }` | `{ "summary", "steps", "result" }` |

Memebuy 已建立独立文档边界，但当前没有明确归属的 production Process。场景入口和归属规则见 [`docs/processes/README.md`](docs/processes/README.md)。

`composed-task/v1` 由 `COMPOSED_TASK_ENABLED=true` 开启：一个 Planner Agent 在服务端预算内组合上面七个 Process，每一步仍走对应 Process 自己的校验与治理，调用方只提交目标与素材。

全部流程共享同一个 `POST /execute` Interface。每个明确版本由 Process Registration 绑定业务定义、Schema、依赖、运行活动和策略，再进入不可变 Process Registry。Process Runner 统一处理 `runId`、精确版本查找、超时、取消、错误净化和可选 Run Record。

每次 Process Attempt 都输出不含业务内容的结构化活动日志。可选 Run Record 保存终态与活动归档，但只用于观测，不决定业务状态。运维控制台提供检索、统计和异步提交；它没有应用内鉴权，生产访问控制由部署平台负责。详细语义见 [Process Runtime 设计](docs/process-runtime-design.md)。

生产启动通过 Installed Skill Catalog 校验 Runtime Skill 的准确名称、版本和 SHA-256。Process 只加载 Registration 固定绑定的 Skill 与窄 Tool；运行期不发现、下载或更新 Skill。

图片 Process 只公开业务输入和图片引用。Prompt、模型、供应商、Skill 和存储配置留在服务端。内部新闻图片评测默认关闭，只在受控环境复用同一次正式 Process 执行。

## 按 Business Process 查看

每个 production Process 都有独立文档目录。先从对应目录确认产品契约、执行顺序、依赖、错误和验证入口，再进入 Implementation：

| 场景 | Process 文档 | 主要 Registration |
| --- | --- | --- |
| [`common`](docs/processes/common/) | 文本处理、海报与 CRT 图片 | [`src/processes/`](src/processes) |
| [`memene`](docs/processes/memene/) | 三个新闻图片 Process | [`src/processes/news-image/registration.ts`](src/processes/news-image/registration.ts) |
| [`memebuy`](docs/processes/memebuy/) | 暂无已登记 Process | — |

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

Agent 可以直接读取生产入口 [`https://pi.ganjiuwanshi.com/llms.txt`](https://pi.ganjiuwanshi.com/llms.txt)，并从中进入完整 Markdown 调用契约 [`https://pi.ganjiuwanshi.com/docs/api.md`](https://pi.ganjiuwanshi.com/docs/api.md)。仓库内的规范性来源仍是 [`llms.txt`](llms.txt) 与 [`docs/api.md`](docs/api.md)。

## 快速开始

需要 Node.js 24 或更高版本。

```bash
npm install
cp .env.example .env
```

`.env` 已被 Git 忽略。文本 Direct 路径不调用模型；执行海报业务验收、文本 Agent 路径或真实模型 smoke 时需要模型凭证。不要把真实凭证提交到仓库。

生产预检、Compose 形状、异步发布和付费 smoke 不属于快速开始。部署前分别阅读 [同步发布手册](docs/mvp-release-runbook.md) 与 [异步发布手册](docs/async-process-runs-runbook.md)。

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
curl -X POST http://127.0.0.1:4300/execute \
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
curl http://127.0.0.1:4300/healthz
```

`GET /healthz` 只确认进程完成初始化，不访问模型或 Business Capability。

`GET /readyz` 表达当前角色所需依赖是否就绪；默认同步形状不访问外部依赖。异步阶段的 readiness 门槛见 [异步发布手册](docs/async-process-runs-runbook.md)。

## 异步开发 Interface

仓库已提供资源式的 `POST /process-runs` 和 `GET /process-runs/{runId}`。它要求网关验证身份、注入固定 caller 头与共享凭证，并要求每次提交携带 `Idempotency-Key`。成功提交返回 `202`、`Location`、`Retry-After` 和 queued Run；查询只向 owner 返回 queued、running、succeeded 或 failed。结果内容到期后，终态和完成时间仍在 metadata 保留期内可查，并返回 `resultAvailability: "expired"` 与 `resultExpiredAt`，不会把内容缺失伪装成空结果。

运维可通过服务端只读 marker 暂停新异步提交；此时 POST 返回 `503 ASYNC_INTAKE_CLOSED`，但既有 owner 查询和同步 `/execute` 保持可用。完整产品契约见 [`docs/api.md`](docs/api.md#异步执行)，操作步骤见[异步发布手册](docs/async-process-runs-runbook.md#真实网关-smoke-与安全回滚)。

本地异步开发通过 Vite-only Gateway 注入测试身份，并用隔离 PostgreSQL、Redis 和受控 Capability 验证提交、刷新恢复与终态。命令、安全边界和故障演练见 [异步 Process Run 开发指南](docs/async-process-runs-development.md)。

该 Interface 由 `ASYNC_PROCESS_RUNS_ENABLED=true` 显式启用，默认关闭，并要求明确的 `internal`、`canary` 或 `production` 阶段。仓库已经实现 transactional Outbox、相互隔离的 Process/Webhook BullMQ Queue、租约恢复、Queue 重建、容量门禁、运维快照和有期限停机。新提交在 durable backlog 达到 caller 上限时返回 `429`，达到全局上限时返回 `503`，两者都带 `Retry-After`；既有 Run 查询不受 admission 影响。完整契约见 [`docs/async-process-runs-design.md`](docs/async-process-runs-design.md)，受控发布步骤见 [`docs/async-process-runs-runbook.md`](docs/async-process-runs-runbook.md)。

## Interface 约束

- 调用方必须请求准确的 Process 和版本。未注册版本返回 `PROCESS_NOT_FOUND`。
- 输入严格按该版本的 Schema 校验。无效输入返回 `INVALID_INPUT`。
- 依赖、Agent、输出和超时失败分别返回稳定的公开错误，不透传内部消息。
- 非 JSON、请求体过大和实例容量已满分别返回 `UNSUPPORTED_MEDIA_TYPE`、`REQUEST_TOO_LARGE` 和 `SERVICE_BUSY`。
- 调用方不能上传流程步骤、脚本、模型、Skill、Tool 或远程地址。
- 当前同步入口默认不持久化 Run Record。结构化活动日志也不是权威状态或产品查询 Interface；异步入口使用独立的权威 Process Run Store。两种入口都不把 `runId` 当作聊天会话 ID。

## 当前边界

默认发布是受控、同步的服务；异步 Interface 已实现但默认关闭。部署平台必须提供 TLS、私有入口、调用方认证、Secret 注入和实例上限。开放异步流量前必须完成 migration、身份、容量、恢复、安全、观测和 staged rollout 门禁。

图片 Process 隐藏模型、供应商和存储配置。真实图片与 OSS 验收默认关闭；生产发布仍需确认内部 Business API 隔离、来源 URL 策略、存储生命周期、证据关闭和上游 Skill 使用权。

## 文档导航

| 文档 | 面向谁 | 回答什么 |
| --- | --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | 产品与开发者 | 项目目的、范围、信任模型和共同语言 |
| [`docs/README.md`](docs/README.md) | 所有维护者 | 文档索引、分类和维护规范 |
| [`llms.txt`](llms.txt) | 调用 Agent | 生产 API 的 Agent 导航、执行选择和安全边界 |
| [`docs/api.md`](docs/api.md) | 产品调用方与 Agent | 全部业务调用路由、Process 入参、响应、重试和 Webhook 契约 |
| [`docs/development.md`](docs/development.md) | 开发者 | 本地开发、代码地图、改动路径和验证要求 |
| [`docs/authoring-business-processes.md`](docs/authoring-business-processes.md) | 产品与开发者 | 如何把自然语言流程描述封装为版本化 Business Process |
| [`docs/processes/README.md`](docs/processes/README.md) | 产品与开发者 | 每个 production Business Process 的独立文档入口 |
| [`docs/integrating-runtime-skills.md`](docs/integrating-runtime-skills.md) | 开发者 | 如何从本地路径或远程来源审查、固定并接入 Skill |
| [`docs/process-runtime-design.md`](docs/process-runtime-design.md) | 开发者 | Module、Interface、执行 invariant 和错误归属 |
| [`docs/async-process-runs-design.md`](docs/async-process-runs-design.md) | 开发者 | 异步提交、持久化查询、BullMQ Worker 和 Webhook 设计 |
| [`docs/async-process-runs-development.md`](docs/async-process-runs-development.md) | 开发者 | 异步角色、本地依赖、集成测试和故障演练 |
| [`docs/async-process-runs-runbook.md`](docs/async-process-runs-runbook.md) | 发布与运维人员 | 异步 migration、容量、观测、故障演练、灰度与回滚 |
| [`docs/experiments.md`](docs/experiments.md) | 开发者 | Agent、Skill、图片与对象存储的真实集成验证 |
| [`docs/mvp-release-runbook.md`](docs/mvp-release-runbook.md) | 发布与运维人员 | 受控 Business Process MVP 的部署门禁、验收和回滚 |

先读 [`CONTEXT.md`](CONTEXT.md) 建立项目语境；准备改代码时再读 [`docs/development.md`](docs/development.md)。
