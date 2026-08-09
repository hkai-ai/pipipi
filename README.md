# Business Processing Service

一个轻量的版本化业务处理服务。产品调用方只提交 Business Process、准确版本和业务输入；服务端用代码绑定 Schema、业务行为、获准依赖和稳定策略。流程内部可以使用本地逻辑、远程 Business Capability 或受限 Agent，产品契约不随实现方式变化。

## 当前能力

生产 catalog 包含两个 Business Process：

| Process | 输入 | 输出 |
| --- | --- | --- |
| `content-processing/v1` | `{ "content": string }` | `{ "content": string }` |
| `titled-content-processing/v1` | `{ "title": string, "body": string }` | `{ "title": string, "content": string }` |

两个流程共享同一个 `POST /execute` Interface。每个明确版本由 Process Registration 绑定业务定义、Schema、依赖和策略，再进入不可变 Process Registry。Process Runner 统一处理 `runId`、精确版本查找、超时、取消、错误净化和可选 Run Record。

## 快速开始

需要 Node.js 24 或更高版本。

```bash
npm install
cp .env.example .env
```

`.env` 已被 Git 忽略。Direct 路径不需要模型凭证；只有 Agent 和真实模型实验需要 `OPENAI_API_KEY`。不要把真实凭证提交到仓库。

在第一个终端启动演示 Business Capability：

```bash
npm run dev:business-api
```

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

`GET /readyz` 表达当前角色所需依赖是否就绪；默认同步形状不访问外部依赖。启用异步入口后会检查 PostgreSQL migration，`canary` 与 `production` 阶段还检查容量、stuck Run、Outbox 延迟和最近人工全量恢复。

## 异步开发 Interface

仓库已提供资源式的 `POST /process-runs` 和 `GET /process-runs/{runId}`。它要求网关验证身份、注入固定 caller 头与共享凭证，并要求每次提交携带 `Idempotency-Key`。成功提交返回 `202`、`Location`、`Retry-After` 和 queued Run；查询只向 owner 返回 queued、running、succeeded 或 failed。结果内容到期后，终态和完成时间仍在 metadata 保留期内可查，并返回 `resultAvailability: "expired"` 与 `resultExpiredAt`，不会把内容缺失伪装成空结果。

该 Interface 由 `ASYNC_PROCESS_RUNS_ENABLED=true` 显式启用，默认关闭，并要求明确的 `internal`、`canary` 或 `production` 阶段。仓库已经实现 transactional Outbox、相互隔离的 Process/Webhook BullMQ Queue、租约恢复、Queue 重建、容量门禁、运维快照和有期限停机。新提交在 durable backlog 达到 caller 上限时返回 `429`，达到全局上限时返回 `503`，两者都带 `Retry-After`；既有 Run 查询不受 admission 影响。完整契约见 [`docs/async-process-runs-design.md`](docs/async-process-runs-design.md)，受控发布步骤见 [`docs/async-process-runs-runbook.md`](docs/async-process-runs-runbook.md)。

## Interface 约束

- 调用方必须请求准确的 Process 和版本。未注册版本返回 `PROCESS_NOT_FOUND`。
- 输入严格按该版本的 Schema 校验。无效输入返回 `INVALID_INPUT`。
- 依赖、Agent、输出和超时失败分别返回稳定的公开错误，不透传内部消息。
- 非 JSON、请求体过大和实例容量已满分别返回 `UNSUPPORTED_MEDIA_TYPE`、`REQUEST_TOO_LARGE` 和 `SERVICE_BUSY`。
- 调用方不能上传流程步骤、脚本、模型、Skill、Tool 或远程地址。
- 当前同步入口默认不持久化 Run Record。异步入口使用独立的权威 Process Run Store；两者都不把 `runId` 当作聊天会话 ID。

## 当前边界

默认发布仍是受控、同步、无状态的 MVP。部署平台必须提供 TLS、私有入口、调用方认证、Secret 注入和实例上限。异步实现已具备受控发布门禁，但不会自动启用；发布人员必须按异步 Runbook 完成 migration、身份、容量、恢复、安全、观测和 staged rollout。当前发布不提供应用用户系统、RBAC、多租户、CORS、通用幂等或动态流程注册。

仓库内已有 Async Process Runs Module、事务化 PostgreSQL Store、Process/Webhook Outbox，以及相互隔离的 BullMQ Process Queue 和 Webhook Queue。`npm run start:api`、`npm run start:dispatcher`、`npm run start:worker`、`npm run start:webhook-worker` 和 `npm run start:retention-cleaner` 从同一构建产物启动独立角色。Process 默认只执行一次，只有服务端 Registration 明确声明安全错误、次数和退避时才会重试；Webhook 已支持精简终态事件、Standard Webhooks 签名、PostgreSQL 权威的有界重试、Attempt 审计、受控人工重放、加密 Secret 和防 SSRF 的固定目标连接。Retention Cleaner 按固定 cutoff 分批删除到期内容，批次审计和返回游标允许安全续跑。Redis Queue 丢失时，`npm run recover:queue` 默认先做 PostgreSQL 权威的 dry-run，再由运维人员显式 `--apply` 重建所有仍需执行的 Job；终态 Run 永不进入恢复候选。`npm run observe:async` 从 PostgreSQL 和两个 Queue 读取不含业务内容的运维快照，Dashboard/alert 字段固定在 `ops/async-observability.json`。

图片生成、海报 Skill、对象存储和 Skill A/B 对比属于开发实验与集成验证，尚未进入 `/execute` 的生产 catalog。

## 文档导航

| 文档 | 面向谁 | 回答什么 |
| --- | --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | 产品与开发者 | 项目目的、范围、信任模型和共同语言 |
| [`docs/README.md`](docs/README.md) | 所有维护者 | 文档索引、分类和维护规范 |
| [`docs/development.md`](docs/development.md) | 开发者 | 本地开发、代码地图、改动路径和验证要求 |
| [`docs/authoring-business-processes.md`](docs/authoring-business-processes.md) | 产品与开发者 | 如何把自然语言流程描述封装为版本化 Business Process |
| [`docs/integrating-runtime-skills.md`](docs/integrating-runtime-skills.md) | 开发者 | 如何从本地路径或远程来源审查、固定并接入 Skill |
| [`docs/process-runtime-design.md`](docs/process-runtime-design.md) | 开发者 | Module、Interface、执行 invariant 和错误归属 |
| [`docs/async-process-runs-design.md`](docs/async-process-runs-design.md) | 开发者 | 异步提交、持久化查询、BullMQ Worker 和 Webhook 设计 |
| [`docs/async-process-runs-development-plan.md`](docs/async-process-runs-development-plan.md) | 开发者 | 异步能力的开发批次、测试门槛和发布顺序 |
| [`docs/async-process-runs-runbook.md`](docs/async-process-runs-runbook.md) | 发布与运维人员 | 异步 migration、容量、观测、故障演练、灰度与回滚 |
| [`docs/experiments.md`](docs/experiments.md) | 开发者 | Agent、Skill、图片与对象存储的真实集成验证 |
| [`docs/mvp-release-runbook.md`](docs/mvp-release-runbook.md) | 发布与运维人员 | 受控文本 MVP 的部署门禁、验收和回滚 |

先读 [`CONTEXT.md`](CONTEXT.md) 建立项目语境；准备改代码时再读 [`docs/development.md`](docs/development.md)。
