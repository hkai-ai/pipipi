# Business Processing Service

一个轻量的业务处理服务原型。产品调用方只需要指定 Business Process、明确版本和业务输入；流程内部按代码定义依次完成预处理、处理和后处理。每个阶段可以使用本地逻辑、直接 API 或受限 Agent，调用方不需要指定实现方式。

当前包含两个代码定义流程：

- `content-processing` / `v1`：输入和输出均为 `{ "content": string }`，服务端可配置为直接调用能力或通过 Pi Agent 优化。
- `titled-content-processing` / `v1`：输入为 `{ "title": string, "body": string }`，输出为 `{ "title": string, "content": string }`，复用同一个内容处理能力，但拥有独立的整理阶段和配置。

流程由 Process Registry 注册，通过 Process Runner 执行。远程业务调用实现为可替换的 Business Capability Adapter，因此多个流程可以复用同一能力，测试也可以注入受控 Adapter。

## 本地运行

要求 Node.js 24 或更高版本。

安装依赖：

```bash
npm install
```

复制环境变量模板；`.env` 已被 Git 忽略：

```bash
cp .env.example .env
```

直接路径不需要模型凭证。使用 Agent、运行 Skill A/B 实验或生成测试图片前，在本地 `.env` 中填写 `OPENAI_API_KEY`，不要把真实 Key 提交到仓库。`npm run dev`、`npm start`、`npm run smoke:agent`、`npm run test:skill-ab` 和 `npm run test:gpt-image-2` 会自动读取该文件。

终端一启动演示业务 API：

```bash
npm run dev:business-api
```

终端二启动处理服务：

```bash
BUSINESS_API_BASE_URL=http://127.0.0.1:4000 npm run dev
```

默认使用不启动 Agent 的确定性直接路径。单次流程超时为 30 秒，单次业务 API 调用超时为 10 秒，可以分别通过 `PROCESS_TIMEOUT_MS` 和 `BUSINESS_API_TIMEOUT_MS` 调整。

调用流程：

```bash
curl -X POST http://127.0.0.1:3000/execute \
  -H 'content-type: application/json' \
  -d '{
    "process": "content-processing",
    "version": "v1",
    "input": { "content": "  launch   offer  " }
  }'
```

成功响应包含 `runId` 和经过业务 API 处理、后处理后的结构化 `output`：

```json
{
  "runId": "...",
  "process": "content-processing",
  "version": "v1",
  "status": "succeeded",
  "output": { "content": "Processed: launch offer" }
}
```

第二个流程仍使用同一个 `/execute` 接口：

```bash
curl -X POST http://127.0.0.1:3000/execute \
  -H 'content-type: application/json' \
  -d '{
    "process": "titled-content-processing",
    "version": "v1",
    "input": { "title": "Launch", "body": "New offer" }
  }'
```

## 可选 Pi Agent 路径

Agent 只由服务端为 `content-processing` 流程开启，产品请求和输出契约不会变化：

```bash
BUSINESS_API_BASE_URL=http://127.0.0.1:4000 \
CONTENT_PROCESSING_MODE=agent \
npm run dev
```

Pi Agent 每次请求创建独立的内存会话，显式加载 `.pi/skills/content-optimization/SKILL.md`，并且只允许调用 `process_business_content` 这一个参数受校验的 Tool。该 Tool 包装已有的 Business Capability；Shell、文件读写、代码编辑等 Coding Tools 不会暴露给 Agent。

默认使用 Pi 已配置的模型和认证。需要固定模型时同时设置 `PI_PROVIDER` 和 `PI_MODEL`；OpenAI 兼容网关通过 `OPENAI_BASE_URL` 配置。`OPENAI_API_MODE` 默认为兼容性更广的 `chat-completions`，实现了 `/v1/responses` 的网关可以改为 `responses`。也可以通过 `PI_AGENT_DIR` 指定 Pi 配置目录。只设置其中一个模型字段会在启动时被拒绝。

真实模型冒烟验证不会进入默认测试套件。先运行演示业务 API，再执行：

```bash
BUSINESS_API_BASE_URL=http://127.0.0.1:4000 npm run smoke:agent
```

该命令会临时启动 Agent 模式服务、完成一次真实 `/execute` 请求，并确认 Agent 实际调用了配置的 Business Capability。命令需要可用的 Pi 模型凭证，可能产生模型费用，但不会输出业务内容或 Tool 输入。

### Skill A/B 对比实验

项目安装了 `obra/the-elements-of-style` 的 `writing-clearly-and-concisely` Skill，并提供三组可观测实验：确定性直接路径、使用透传控制 Skill 的 Agent、使用候选写作 Skill 的 Agent。三组使用相同输入和 Business API；实验会记录 API 实际收到的 Tool 入参，并检查候选 Skill 专属 canary、目标冗余短语、文本长度、Tool 调用次数和最终输出来源。

不调用模型的实验预检：

```bash
SKILL_AB_DRY_RUN=1 npm run test:skill-ab
```

使用 OpenAI 运行完整实验：

```bash
npm run test:skill-ab
```

该命令从本地 `.env` 读取 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_API_MODE`。默认模型为 `openai/gpt-5.6-terra`；需要覆盖时，修改 `.env` 中的 `PI_PROVIDER` 和 `PI_MODEL`，或只为一次运行设置：

```bash
PI_PROVIDER=openai \
PI_MODEL=gpt-5.6-terra \
npm run test:skill-ab
```

不要把 API Key 写入仓库、Skill 或测试输入。实验只在临时目录生成两个 Skill 适配文件，结束后自动删除；第三方 Skill 原文件保持不变。输出中的 `passed: true` 表示所有结构和行为判据同时成立。

每次真实实验都会把完整证据保存到 `artifacts/skill-ab/latest.json` 和便于阅读的 `artifacts/skill-ab/latest.md`。报告包含三组 Business API 实际入参、最终输出和逐项判据，但不包含 API Key 或 Base URL。dry-run 不会覆盖真实实验报告。

### GPT Image 2 + 海报 Skill 测试

项目安装了 [`LiamGvchi/gc-minimal-zine-poster`](https://github.com/LiamGvchi/gc-minimal-zine-poster) Skill。测试按固定流程执行：Pi Agent 读取 Skill 并把业务主题编译成四段图片 Prompt，代码随后直接调用 `POST /v1/images/generations`，最后保存图片和证据报告。启用对象存储后，流程还会通过通用 `ObjectStorageCapability` 上传图片并返回 URL。业务输入不选择 Skill、API 或存储厂商；测试流程在服务端绑定这些实现。

运行真实测试：

```bash
npm run test:gpt-image-2
```

默认使用 `PI_PROVIDER` 和 `PI_MODEL` 完成 Prompt 编译，再用 `gpt-image-2` 生成一张低质量 1024×1696 PNG。`OPENAI_BASE_URL` 必须提供 Images API；`OPENAI_API_MODE` 只控制 Agent 阶段。图片生成可能产生费用，并可能运行两分钟。可在 `.env` 中覆盖 `GPT_IMAGE_THEME`、`GPT_IMAGE_SIZE`、`GPT_IMAGE_QUALITY`、`GPT_IMAGE_OUTPUT_FORMAT` 和两个超时值。

测试检查 Skill 文件哈希、Prompt 来源、四段结构、六轴 recipe、3:5 画幅、留白、纸张与印刷细节、颜色锚点、实际 raster bytes 和图片尺寸。结果保存在：

- `artifacts/gpt-image-2/latest.png`
- `artifacts/gpt-image-2/latest.json`
- `artifacts/gpt-image-2/latest.md`

报告不会记录 API Key 或 Base URL。如果 Agent 阶段失败，测试仍会用代码内的基准 Prompt 调用 Images API，以便区分 Skill/Agent 故障和图片接口故障；这种情况的最终结果仍为 `FAIL`。

### 阿里云 OSS 图片上传

对象存储默认关闭，图片仍只写入本地 `artifacts/`。在 `.env` 中启用 OSS 后，同一个图片测试会上传生成结果，并在终端、JSON 报告和 Markdown 报告中返回 `bucket`、`objectKey`、`url`、URL 访问方式、过期时间、ETag 和 OSS Request ID：

```dotenv
OBJECT_STORAGE_PROVIDER=aliyun-oss
OSS_REGION=oss-cn-hangzhou
OSS_BUCKET=your-private-bucket
OSS_ACCESS_KEY_ID=your-ram-or-sts-access-key-id
OSS_ACCESS_KEY_SECRET=your-ram-or-sts-access-key-secret
OSS_URL_ACCESS=signed
OSS_SIGNED_URL_TTL_SECONDS=3600
```

默认使用私有桶和 Signature V4，返回一小时有效的 GET 签名 URL。签名 URL 是临时 bearer credential；报告目录已被 Git 忽略，但仍不应公开。使用 STS 临时凭证时再设置 `OSS_STS_TOKEN`。生产环境应给 RAM 身份最小的 `oss:PutObject` 和 `oss:GetObject` 权限，并由部署平台注入凭证；不要把长期 AccessKey 写入仓库。

自 2025 年 3 月 20 日起，中国大陆地域的新 OSS 用户需要用已绑定的自定义域名访问数据 API，并同时设置 `OSS_ENDPOINT=https://oss-upload.example.com` 和 `OSS_CNAME=true`。如果图片本来就是公共资源或通过 CDN 分发，改用 `OSS_URL_ACCESS=public` 和 `OSS_PUBLIC_BASE_URL=https://assets.example.com`；代码只拼接稳定 URL，不会替你修改桶 ACL 或 CDN 权限。对象键使用图片内容哈希，重复上传同一图片会落到同一个地址；可用 `GPT_IMAGE_OBJECT_PREFIX` 修改前缀。

`ObjectStorageCapability` 只暴露一个内存字节上传方法。`AliyunOssStorage` 隐藏 SDK、V4 签名、超时、URL 生成和安全错误转换，因此以后增加 R2 或 S3 Adapter 时不需要改图片流程。当前 HTTP 服务没有开放任意文件上传接口；如果以后需要浏览器直传，应单独增加受鉴权的签名 PUT 流程和对象键策略。

只验证 OSS、不重新调用模型时，先确认 `artifacts/gpt-image-2/latest.png` 存在，再运行：

```bash
npm run smoke:oss
```

该命令上传现有图片，并通过返回 URL 请求第一个字节。终端会直接打印结果，完整证据保存在 `artifacts/object-storage/latest.json`。可用 `OSS_SMOKE_FILE` 换成本地其他文件；此命令会产生一次 OSS PUT 和一次少量 GET 请求。

## 增加业务流程

流程结构保持在 TypeScript 代码中，不使用 JSON 工作流语言：

1. 新建一个工厂函数，通过 `defineProcess` 声明固定的 `id`、`version`、输入 Schema、输出 Schema 和 `execute` 阶段。
2. 在 `createProcessingApplication` 的 Process Registry 中注册这个工厂函数。
3. 通过 `context.capabilities` 复用已有能力，或增加一个窄接口 Adapter；不要让产品请求携带步骤、URL 或实现选择。
4. 为新流程增加独立的服务端配置和 `/execute` 外部行为测试。

`src/titled-content-processing.ts` 是最小可复制示例。只有稳定的运行开关、超时和分隔符等策略使用环境配置；流程拓扑和业务语义仍由代码与测试约束。

## 接口约束

- 流程由服务端代码定义，调用方不能上传流程步骤、脚本或远程地址。
- 未注册的流程或版本返回 `PROCESS_NOT_FOUND`。
- 无效业务输入返回 `INVALID_INPUT`。
- 远程 Business Capability 不可用时返回 `DEPENDENCY_FAILURE`，不会透传远端错误内容。
- 超过流程总时限时返回 `PROCESS_TIMEOUT`。
- Agent 执行或结构化输出失败时返回 `AGENT_FAILURE`，不会透传模型或认证错误。
- 非 JSON 请求返回 `UNSUPPORTED_MEDIA_TYPE`；超过字节上限的请求返回 `REQUEST_TOO_LARGE`。
- 实例容量已满时返回 `SERVICE_BUSY` 和 `Retry-After`，不会在进程内排队。
- `GET /healthz` 只检查进程是否已初始化，不访问模型或 Business Capability。
- 当前版本是受控同步 MVP，不包含应用鉴权、幂等、队列、持久化执行记录或通用编排器。

## 部署与 Skill 边界

当前服务是标准 Node.js 24 HTTP 进程，监听 `0.0.0.0:$PORT`。仓库中的多阶段 Dockerfile 只把生产依赖、编译产物和审核后的内容优化 Skill 放入运行镜像，并以非 root 用户启动。ECS、SAE、ACK、Cloud Run、ECS/Fargate、Kubernetes 和普通 Docker 主机可以运行同一镜像。

部署平台必须提供 TLS、私有入口和调用方认证，并阻止外部客户端绕过入口访问容器端口。浏览器通过现有后端或 BFF 调用；服务不启用 CORS。每个请求保留独立 Agent 会话，实例之间不共享业务状态，因此平台可以水平扩容。应用用 `MAX_CONCURRENT_EXECUTIONS` 限制单实例并发；平台还必须限制最大实例数。

构建镜像：

```bash
docker build -t pi-business-processing-service:local .
```

完整的配置、容量档位、私有入口验收、真实 Agent 冒烟和回滚步骤见 [`docs/mvp-release-runbook.md`](docs/mvp-release-runbook.md)。

图片生成可能接近两分钟，应让平台请求超时高于 `PROCESS_TIMEOUT_MS` 和 `GPT_IMAGE_TIMEOUT_MS`。本地文件只适合单机测试；国内多实例或无状态部署应设置 `OBJECT_STORAGE_PROVIDER=aliyun-oss`，让生成图片进入 OSS。证据报告目前仍写本地文件，生产化时应再接入持久化日志或对象存储。

Vercel Functions、Netlify Functions 和 Cloudflare Workers 不能直接运行当前入口。它使用 `node:http` 主动监听端口，并依赖本地 Skill 文件；部署到这些运行时需要改成平台 Handler，并重新处理文件资源和长请求。

当前生产 Agent 只加载一个指令型 Skill，并只暴露 `process_business_content`。它适合单文件规则、分类、抽取、改写、Prompt 编译和一到数个受控 API Tool。海报测试证明约 13 KB、包含多组规则和选择轴的 Skill 可以稳定完成 Prompt 编译。

以下能力还未进入生产 Agent：自动读取 Skill 的附加参考文件、运行 Skill 脚本、任意 Shell 或文件操作、MCP、持久记忆，以及看图后自动重试。完整执行海报 Skill 的视觉质量门，需要再增加受限的图片生成 Tool、视觉检查能力、最多一次重试和对象存储。不要为了兼容复杂 Skill 直接开放 Coding Tools；按业务流程逐个增加窄 Capability 更安全，也更容易测试。

## 验证

```bash
npm run typecheck
npm test
npm run build
docker build -t pi-business-processing-service:local .
```

对已部署的受控环境执行真实集成门禁：

```bash
STAGING_SERVICE_BASE_URL=https://private-agent.example.internal \
STAGING_AUTHORIZATION='Bearer replace-with-short-lived-token' \
npm run smoke:staging
```
