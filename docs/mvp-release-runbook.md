# 受控 Business Process MVP 发布手册

本手册面向发布与运维人员，用于发布现有同步 Business Process 服务，包括文本处理、`minimal-zine-poster/v1` 与 `crt-interface-image/v1`。生产服务通过受控 Rendering Capability 获取图片 URL；供应商专用的 OpenAI Images 和 OSS Adapter 只用于显式真实集成与本地业务验收。CRT 候选还依赖产品图片上传、`POST /crt-images`、确定性 finalizer 和来源权利确认；缺少任一门禁时不得发布包含该 catalog 的候选镜像。本文不发布异步作业或公网匿名接口。项目范围以
[`CONTEXT.md`](../CONTEXT.md) 为准；文档维护要求见 [`docs/README.md`](README.md)。

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
| Poster Rendering Capability 超时 | 90 秒 | `POSTER_API_TIMEOUT_MS=90000` |
| CRT Rendering Capability 超时 | 180 秒 | `CRT_API_TIMEOUT_MS=180000` |
| Process Run 超时 | 240 秒 | 本发布显式设置 `PROCESS_TIMEOUT_MS=240000`；代码默认 30 秒 |
| 平台请求超时 | 270–300 秒 | 必须长于 Process Run 超时 |

服务在上限以内并发执行请求。每个 Agent 请求建立独立内存会话；实例之间不共享业务会话，因此平台可以水平扩容。提升并发或实例数前，先检查实例内存、P95 延迟、Business Capability 容量、模型配额和单次运行成本。

## 运行配置

部署平台通过环境变量和 Secret 注入配置。镜像不包含 `.env` 文件或凭证。

| 变量 | 要求 |
| --- | --- |
| `BUSINESS_API_BASE_URL` | 必填；必须指向容器可达且实现 `POST /process`、`POST /posters` 与 `POST /crt-images` 的真实 Business API，禁止使用 `localhost` 演示地址 |
| `PORT` | 可选；默认 `3000` |
| `CONTENT_PROCESSING_MODE` | `direct` 或 `agent`；默认 `direct` |
| `HTTP_MAX_REQUEST_BODY_BYTES` | 正整数；默认 `262144` |
| `MAX_CONCURRENT_EXECUTIONS` | 正整数；默认 `4` |
| `BUSINESS_API_TIMEOUT_MS` | 正整数；代码默认 `10000`，本发布显式设置 `10000` |
| `POSTER_API_TIMEOUT_MS` | 正整数；代码默认 `90000`，本发布显式设置 `90000` |
| `CRT_API_TIMEOUT_MS` | 正整数；代码默认 `180000`，本发布显式设置 `180000` |
| `PROCESS_TIMEOUT_MS` | 正整数；代码默认 `30000`，本发布必须显式设置 `240000` |
| `PROCESS_RUN_LOG_LEVEL` | Pino 阈值；默认 `info`，生产建议保留 `info` 以观察完整活动时间线 |
| `ASYNC_PROCESS_RUNS_ENABLED` | 本同步 MVP 必须保持 `false`；异步生产发布使用独立 Runbook |
| `PI_PROVIDER`、`PI_MODEL` | 按组设置；海报与 CRT 流程始终使用 Agent |
| `OPENAI_BASE_URL`、`OPENAI_API_MODE` | 使用 OpenAI 或兼容网关时设置 |
| `PI_SKILL_DIRECTORY` | 可选；只覆盖固定的 `content-optimization` 路径，不改变 Skill 集合 |
| `PI_POSTER_SKILL_DIRECTORY` | 可选；只覆盖固定的 `minimal-zine-poster-prompt` 路径 |
| `PI_CRT_SKILL_DIRECTORY` | 可选；只覆盖固定的 `tait-crt-interface-prompt` 路径 |
| `OPENAI_API_KEY` | 执行使用 OpenAI 的 Agent 时由平台 Secret 注入；禁止写入镜像、仓库或普通配置 |

若 Business Capability 需要认证，优先使用私网身份、工作负载身份或服务网格。当前 HTTP Adapter 不发送调用方提供的任意认证头。`POST /posters` 与 `POST /crt-images` 必须以 `Idempotency-Key: <runId>` 去重，并返回在声明期限内可访问的 HTTP(S) 图片 URL；短期签名 URL 必须返回 `expiresAt`。CRT endpoint 还必须只解析服务端资产标识，不能抓取调用方 URL。生产 Business API 必须把 CRT 证据模式固定为 `off`；`CRT_IMAGE_EVIDENCE_MODE` 属于该服务的部署配置，不注入产品请求。

`PROCESS_TIMEOUT_MS=240000` 是本手册的受控发布覆盖值，不改变代码的 30 秒默认值。它必须长于 `CRT_API_TIMEOUT_MS`；候选镜像、部署平台和回滚配置都必须显式保留该覆盖值。启用异步 Worker 时，`PROCESS_RUN_CLAIM_LEASE_MS` 还必须长于 Process 总超时。

## 运行时兼容性

当前入口是主动监听 `0.0.0.0:$PORT` 的 Node.js 24 HTTP 进程，并在运行时读取镜像内的 Skill 文件。普通 Docker 主机、Kubernetes 和支持长运行容器的平台可以运行同一镜像。

Vercel Functions、Netlify Functions 和 Cloudflare Workers 不能直接运行当前入口。迁移到函数或边缘运行时前，必须把主动监听改成平台 Handler，并重新设计文件资源、长请求、取消和超时。

## Run Record 策略

当前生产启动构造没有注入 Run Record 存储。MVP 依靠部署平台收集 Pino newline-delimited JSON，并按 `runId`、Process、状态和错误码检索。`runId` 是运行排障索引，不是聊天会话 ID；聊天历史应由产品数据库单独保存。

仓库提供的内存 Run Record Adapter 只用于开发或单实例测试。它有容量上限，但重启即丢失，也不在实例之间共享。不要把容器内存或容器磁盘当作生产记录存储。

以后接入 Postgres 或可观测平台时，应实现 `ProcessRunRecordAdapter`，并保持以下边界：

1. 默认只保存运行元数据，不保存输入和输出。
2. 保存业务内容前，先确定授权、租户隔离、加密、脱敏和保留期限。
3. 不保存系统 Prompt、Tool 过程、模型消息、隐藏推理、无效请求内容或内部错误详情；图片 URL 可能是 bearer credential，保存前必须纳入内容授权与保留期评审。
4. Adapter 写入失败不得改变 Process Run 的返回结果。
5. 对外查询记录前，另行增加受鉴权的查询接口；本次发布不包含该接口。

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
  'test -f .pi/skills/content-optimization/SKILL.md && test -f .pi/skills/content-integrity/SKILL.md && test -f .pi/skills/minimal-zine-poster-prompt/SKILL.md && test -f .pi/skills/tait-crt-interface-prompt/SKILL.md && test ! -d node_modules/typescript && test ! -d node_modules/vitest'
```

用生产形状的非秘密配置启动候选镜像。健康检查不得访问模型或 Business Capability：

```bash
docker run --rm -d --name pi-business-processing-rc \
  -p 127.0.0.1:3000:3000 \
  -e BUSINESS_API_BASE_URL=http://business-capability.internal \
  -e BUSINESS_API_TIMEOUT_MS=10000 \
  -e POSTER_API_TIMEOUT_MS=90000 \
  -e CRT_API_TIMEOUT_MS=180000 \
  -e PROCESS_TIMEOUT_MS=240000 \
  -e HTTP_MAX_REQUEST_BODY_BYTES=262144 \
  -e MAX_CONCURRENT_EXECUTIONS=4 \
  -e ASYNC_PROCESS_RUNS_ENABLED=false \
  pi-business-processing-service:rc

curl --fail --silent http://127.0.0.1:3000/healthz
docker stop pi-business-processing-rc
```

## 发布门禁

候选版本必须依次通过以下门禁：

```bash
npm ci
npm run check
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
5. 日志系统必须收到 Pino 单行 JSON，识别数值 `level`，能按 `runId`、`process`、`status|outcome` 和 `errorCode` 检索，并能按 `attemptNumber + sequence` 还原固定活动时间线；日志中不得出现业务内容、Prompt、Tool 参数、模型消息或内部异常正文。
6. `BUSINESS_API_BASE_URL` 必须连接真实 Business Capability。
7. `POST /posters` 必须按 `runId` 去重，并验证图片 URL 的访问控制、有效期、媒体类型和尺寸。
8. `POST /crt-images` 必须按 `runId` 去重，并验证资产权限、GPT Image 2 编辑、finalizer、PNG 引用、费用和删除生命周期；生产证据模式必须为 `off`，或有单独批准的数据保留策略。
9. 若候选版本注入了 Run Record Adapter，必须验证成功和失败记录可按 `runId` 查询，并验证存储故障不影响 `/execute` 结果。

Agent 模式启用后，先在受控发布 runner 中连接真实模型和 Business Capability。该命令强制使用 Agent 模式；若 Agent 未恰好调用一次 Business Capability、最终输出并非来自 Tool 结果，或默认受保护内容在 Tool 输入中发生变化，命令会失败。它可能产生模型费用：

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

第一条命令证明真实 Agent 和 Business Capability 都参与执行，并检查 Tool 调用次数、结果来源与默认受保护内容。第二条命令检查健康状态、一次结构化成功结果和一个字段严格受限的 `INVALID_INPUT` 失败响应。两条命令都不比较精确文案，也不输出业务内容、Tool 输入或认证值。

海报候选还必须运行本地业务验收。它会从产品 `POST /execute` 进入 production catalog，调用真实 Agent、production HTTP Adapter、受控 `POST /posters` Capability 与所选图片 Adapter；配置 OSS 时还会写远端对象。先确认测试主题、凭证、bucket、对象前缀和费用范围：

```bash
npm run accept:poster-business
```

通过后检查报告中的 `POST /execute` HTTP 200、单次 `POST /posters`、`runId` 幂等键、`minimal-zine-poster/v1`、四段 Prompt、六轴 recipe、图片字节、3:5 尺寸和 URL 下载哈希。该命令使用本地受控 Business API，不替代目标部署对 `POST /posters` 容量、权限和 URL 生命周期的验收。

CRT 候选先运行显式 GPT Image 2 edit smoke。它读取本地参考图、产生模型费用并写 `artifacts/`；确认图片不敏感、凭证和费用范围后再运行：

```bash
CRT_SOURCE_IMAGE_FILE=/absolute/path/to/non-sensitive-test-image.png \
npm run smoke:crt-gpt-image
```

该 smoke 不运行 Runtime Skill Agent、production catalog、资产服务或 finalizer。随后用同一张非敏感参考图运行无 OSS 本地业务验收：

```bash
CRT_SOURCE_IMAGE_FILE=/absolute/path/to/non-sensitive-test-image.png \
npm run accept:crt-business
```

该命令从临时 `POST /assets` 上传进入产品 `POST /execute`，验证真实 Agent、单次 `POST /crt-images`、`runId` 幂等、GPT Image 2 编辑、确定性 finalizer、目标尺寸与调色板、PNG 下载和无 OSS 判据。默认 `full` 证据模式还会按 `runId` 保存原图、模型原始图、最终图和脱敏 manifest，供发布负责人核对真实调用链。若 Agent 网关不实现标准 Images API，可用 `OPENAI_IMAGE_BASE_URL` 和 `OPENAI_IMAGE_API_KEY` 直连 OpenAI Images，也可设置 `IMAGE_PROVIDER=fal` 与 `FAL_KEY` 改用 FAL。发布门禁必须记录实际供应商，并单独评审凭证、数据保留、费用和故障语义。

本地通过仍不满足生产发布门禁。发布前必须按 [`processes/crt-interface-image/`](processes/crt-interface-image/) 完成来源授权、生产上传的身份与资产安全、生产 `POST /crt-images`、持久化 URL、删除生命周期、九种调色板、四种画幅和人工视觉验收，并按 [CRT 图片证据保留](processes/crt-interface-image/evidence-retention.md) 确认生产模式与清理责任。

## 发布与回滚

保留上一版本的镜像摘要。先把少量受控流量切到新 revision，观察 5xx、503、超时、内存、模型配额和下游错误，再逐步增加流量。

出现以下任一情况立即回滚：授权路径不可用、容器端口公开可达、错误响应泄露内部信息、持续 5xx、超时显著增加、模型费用越过预算，或 Business Capability 饱和。回滚时把流量切回上一镜像摘要，停止新 revision，验证旧版本 `/healthz`，并用结构化日志保存受影响的 `runId`。

## 本次不发布

本次 MVP 不增加应用用户系统、RBAC、多租户、数据库、持久化或跨实例执行历史、Run Record 查询接口、通用幂等、队列、自动重试、CORS、应用内 OSS Adapter、生成后自动视觉质检、自动重绘或全量基础设施即代码。CRT 的上传 Interface 和资产服务属于产品图片平台，不由本服务公开；产品只把预上传资产的 `sourceImageId` 交给 `/execute`。两个图片流程都有模型费用和图片持久化副作用，必须保持调用权限、`runId` 幂等、并发和费用门禁。
