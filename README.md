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

## Interface 约束

- 调用方必须请求准确的 Process 和版本。未注册版本返回 `PROCESS_NOT_FOUND`。
- 输入严格按该版本的 Schema 校验。无效输入返回 `INVALID_INPUT`。
- 依赖、Agent、输出和超时失败分别返回稳定的公开错误，不透传内部消息。
- 非 JSON、请求体过大和实例容量已满分别返回 `UNSUPPORTED_MEDIA_TYPE`、`REQUEST_TOO_LARGE` 和 `SERVICE_BUSY`。
- 调用方不能上传流程步骤、脚本、模型、Skill、Tool 或远程地址。
- 当前生产入口默认不持久化 Run Record。`runId` 用于排障关联，不是聊天会话 ID。

## 当前边界

这是一个受控、同步、无状态的 MVP。部署平台必须提供 TLS、私有入口、调用方认证、Secret 注入和实例上限。服务本身不提供应用用户系统、RBAC、多租户、CORS、队列、通用幂等、跨实例执行历史或动态流程注册。

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
| [`docs/experiments.md`](docs/experiments.md) | 开发者 | Agent、Skill、图片与对象存储的真实集成验证 |
| [`docs/mvp-release-runbook.md`](docs/mvp-release-runbook.md) | 发布与运维人员 | 受控文本 MVP 的部署门禁、验收和回滚 |

先读 [`CONTEXT.md`](CONTEXT.md) 建立项目语境；准备改代码时再读 [`docs/development.md`](docs/development.md)。
