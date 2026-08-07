# 受控文本 MVP 发布手册

本手册发布现有同步文本处理服务。它不发布图片、OSS、异步作业或公网匿名接口。

## 发布边界

只允许受控调用方通过私有入口或可信网关访问服务。入口必须终止 TLS、认证调用方，并阻止客户端绕过网关访问容器端口。浏览器通过现有后端或 BFF 调用；服务不启用 CORS。

部署平台负责入口认证。应用继续根据服务端注册表决定可用的 Business Process、版本、Agent 模式和 Tool；调用方不能选择模型、Skill、Tool 或下游地址。

## 初始容量与超时

| 控制项 | 初始值 | 约束 |
| --- | ---: | --- |
| 单实例执行并发 | 2–4 | `MAX_CONCURRENT_EXECUTIONS` 必须与平台实例并发相匹配 |
| 最大实例数 | 2–5 | 在平台设置硬上限，形成模型费用上限 |
| 请求体 | 262144 字节 | 用 `HTTP_MAX_REQUEST_BODY_BYTES` 调整 |
| Business Capability 超时 | 10 秒 | `BUSINESS_API_TIMEOUT_MS=10000` |
| Process Run 超时 | 120 秒 | `PROCESS_TIMEOUT_MS=120000` |
| 平台请求超时 | 150–180 秒 | 必须长于 Process Run 超时 |

服务在上限以内并发执行请求。每个 Agent 请求建立独立内存会话；实例之间不共享业务会话，因此平台可以水平扩容。提升并发或实例数前，先检查实例内存、P95 延迟、Business Capability 容量、模型配额和单次运行成本。

## 运行配置

部署平台通过环境变量和 Secret 注入配置。镜像不包含 `.env` 文件或凭证。

| 变量 | 要求 |
| --- | --- |
| `BUSINESS_API_BASE_URL` | 必填；必须指向容器可达的真实 Business Capability，禁止使用 `localhost` 演示地址 |
| `PORT` | 可选；默认 `3000` |
| `CONTENT_PROCESSING_MODE` | `direct` 或 `agent`；默认 `direct` |
| `HTTP_MAX_REQUEST_BODY_BYTES` | 正整数；默认 `262144` |
| `MAX_CONCURRENT_EXECUTIONS` | 正整数；默认 `4` |
| `BUSINESS_API_TIMEOUT_MS` | 正整数；初始值 `10000` |
| `PROCESS_TIMEOUT_MS` | 正整数；初始值 `120000` |
| `PI_PROVIDER`、`PI_MODEL` | Agent 模式下按组设置 |
| `OPENAI_BASE_URL`、`OPENAI_API_MODE` | 使用 OpenAI 或兼容网关时设置 |
| `OPENAI_API_KEY` | 仅通过平台 Secret 注入；禁止写入镜像、仓库或普通配置 |

若 Business Capability 需要认证，优先使用私网身份、工作负载身份或服务网格。当前 HTTP Adapter 不发送调用方提供的任意认证头。

## 构建并检查镜像

从干净的发布提交构建镜像，并记录生成的镜像摘要：

```bash
docker build --pull -t pi-business-processing-service:rc .
docker image inspect pi-business-processing-service:rc --format '{{.Id}}'
```

发布系统应扫描镜像。推送仓库后，记录 registry 返回的 RepoDigest，并按该摘要部署。运行镜像前检查非 root 身份、生产依赖和 Skill：

```bash
docker run --rm --entrypoint id pi-business-processing-service:rc -u
docker run --rm --entrypoint sh pi-business-processing-service:rc -c \
  'test -f .pi/skills/content-optimization/SKILL.md && test ! -d node_modules/typescript && test ! -d node_modules/vitest'
```

用生产形状的非秘密配置启动候选镜像。健康检查不得访问模型或 Business Capability：

```bash
docker run --rm -d --name pi-business-processing-rc \
  -p 127.0.0.1:3000:3000 \
  -e BUSINESS_API_BASE_URL=http://business-capability.internal \
  -e BUSINESS_API_TIMEOUT_MS=10000 \
  -e PROCESS_TIMEOUT_MS=120000 \
  -e HTTP_MAX_REQUEST_BODY_BYTES=262144 \
  -e MAX_CONCURRENT_EXECUTIONS=4 \
  pi-business-processing-service:rc

curl --fail --silent http://127.0.0.1:3000/healthz
docker stop pi-business-processing-rc
```

## 发布门禁

候选版本必须依次通过以下门禁：

```bash
npm ci
npm run typecheck
npm test
npm run build
docker build -t pi-business-processing-service:rc .
```

随后完成环境验收：

1. 从公网直接访问容器地址必须失败。
2. 授权调用方必须能通过 TLS 网关访问 `/healthz` 和 `/execute`。
3. 网关请求超时必须长于 `PROCESS_TIMEOUT_MS`。
4. 平台实例并发不得高于应用并发闸门；平台必须设置最大实例数。
5. 日志系统必须收到单行 JSON，并能按 `runId`、`process`、`status` 和 `errorCode` 检索。
6. `BUSINESS_API_BASE_URL` 必须连接真实 Business Capability。

Agent 模式启用后，先在受控发布 runner 中连接真实模型和 Business Capability。该命令强制使用 Agent 模式；若 Agent 没有实际调用 Business Capability，命令会失败。它可能产生模型费用：

```bash
BUSINESS_API_BASE_URL=https://business-capability.staging.internal \
npm run smoke:agent
```

随后确认部署平台已设置 `CONTENT_PROCESSING_MODE=agent`，再从授权入口检查已部署镜像：

```bash
STAGING_SERVICE_BASE_URL=https://private-agent.example.internal \
STAGING_AUTHORIZATION='Bearer replace-with-short-lived-token' \
npm run smoke:staging
```

第一条命令证明真实 Agent 和 Business Capability 都参与执行。第二条命令检查健康状态、一次结构化成功结果和一个字段严格受限的 `INVALID_INPUT` 失败响应。两条命令都不比较精确文案，也不输出业务内容、Tool 输入或认证值。

## 发布与回滚

保留上一版本的镜像摘要。先把少量受控流量切到新 revision，观察 5xx、503、超时、内存、模型配额和下游错误，再逐步增加流量。

出现以下任一情况立即回滚：授权路径不可用、容器端口公开可达、错误响应泄露内部信息、持续 5xx、超时显著增加、模型费用越过预算，或 Business Capability 饱和。回滚时把流量切回上一镜像摘要，停止新 revision，验证旧版本 `/healthz`，并用结构化日志保存受影响的 `runId`。

## 本次不发布

本次 MVP 不增加应用用户系统、RBAC、多租户、数据库、执行历史、通用幂等、队列、自动重试、CORS、图片生成、OSS 生产链路或全量基础设施即代码。未来流程一旦产生发布、扣费、发送或其他副作用，必须先补幂等决策。
