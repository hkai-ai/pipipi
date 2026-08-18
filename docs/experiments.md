# 实验与真实集成验证

本文面向验证 Agent、Skill、图片生成、对象存储和已部署环境的开发者。这些命令是 production Process 的真实 smoke 或独立实验，可能访问外部系统、产生费用或写入远端存储；默认测试套件不运行它们。

## 安全约束

运行前复制 `.env.example` 为本地 `.env`，再由环境变量或部署平台注入真实凭证。

- 不把 API Key、AccessKey、STS Token、Bearer Token 或签名 URL 提交到仓库。
- 使用测试输入，避免在模型 Prompt、Tool 入参、图片主题或报告中放入敏感业务内容。
- 先运行确定性测试，再运行真实集成命令。
- 查看终端和 `artifacts/` 后再分享结果；生成报告不会主动清理用户提供的业务文本。
- OSS smoke 会执行一次远端 PUT 和少量 GET。确认 bucket、object prefix 和费用范围后再运行。

## 命令总览

| 命令 | 验证目标 | 外部影响 | 主要产物 |
| --- | --- | --- | --- |
| `npm run smoke:agent` | Pi Agent 确实调用唯一获准 Business Capability | 模型调用、业务请求 | 终端判据 |
| `SKILL_AB_DRY_RUN=1 npm run test:skill-ab` | 三组实验结构和 Skill 装载预检 | 无模型调用 | 终端判据 |
| `npm run test:skill-ab` | Direct、控制 Skill、候选 Skill 的行为差异 | 多次模型调用、业务请求 | `artifacts/skill-ab/latest.*` |
| `npm run accept:poster-business`（兼容别名：`smoke:poster-process`、`test:gpt-image-2`） | 从产品 HTTP Interface 验收 `minimal-zine-poster/v1` | Agent、OpenAI Images 或 FAL 请求，可选 OSS PUT | `artifacts/gpt-image-2/latest.*` |
| `npm run smoke:crt-gpt-image` | 用一张本地参考图验证 GPT Image 2 edit stage | 读取本地图片、OpenAI Images 或 FAL 请求、本地写入 | `artifacts/crt-interface-image/latest.*` |
| `npm run accept:crt-business` | 从公网图片 URL 与产品 HTTP Interface 验收 `crt-interface-image/v1` | Agent、FAL、可选 OSS 与本地产物写入 | `artifacts/crt-interface-image/acceptance/latest.*` |
| `npm run accept:news-image-business` | 从产品 HTTP Interface 验收三个新闻图片 Process、FAL 与 OSS | 三次 Agent、三次 FAL 图片生成与三次 OSS PUT | `artifacts/news-image-acceptance/evidence.json` |
| `npm run smoke:oss` | 已有文件的上传、URL 生成和首字节读取 | OSS PUT 与 GET | `artifacts/object-storage/latest.json` |
| `npm run smoke:staging` | 已部署环境的健康、成功与拒绝契约 | 受控环境请求 | 终端判据 |

## Pi Agent 路径

生产内容处理流程可以由服务端切换到 Agent 模式，产品请求和输出契约不变：

```bash
CONTENT_PROCESSING_MODE=agent npm run dev
```

Agent 每次请求创建独立内存会话，并按流程 Module 的准确绑定加载 `.pi/skills/content-optimization/SKILL.md` 与 `.pi/skills/content-integrity/SKILL.md`。Agent 只允许调用 `process_business_content`。这个 Tool 包装现有 Content Processing Capability；Registration 最多让一次调用触达下游，并只接受与 Tool 结果一致的 Agent 输出。Shell、文件读写和代码编辑不会暴露给 Agent。

默认从 `.env` 读取 Pi 模型与 OpenAI 兼容配置。`PI_PROVIDER` 和 `PI_MODEL` 必须同时设置。`OPENAI_API_MODE` 可以是 `chat-completions` 或 `responses`；兼容网关还可通过 `OPENAI_BASE_URL` 配置。图片阶段默认使用 OpenAI Adapter：`OPENAI_IMAGE_BASE_URL` 和 `OPENAI_IMAGE_API_KEY` 可脱离 Agent 网关。设置 `IMAGE_PROVIDER=fal` 与服务端 `FAL_KEY` 后，付费图片命令改用 FAL；产品输入不能选择供应商。

先启动本地演示 Business Capability，再执行真实 Agent smoke：

```bash
BUSINESS_API_BASE_URL=http://127.0.0.1:4000 npm run smoke:agent
```

Smoke 会临时启动 Agent 模式服务，完成一次 `/execute` 请求，并确认 Agent 恰好调用一次 Business Capability、最终输出来自 Tool 结果。未设置 `AGENT_SMOKE_CONTENT` 时，它还检查姓名、日期、数字和链接在 Tool 输入中保持不变。它不输出业务内容或 Tool 入参，但可能产生模型费用。

### 当前 Skill 执行范围

生产 Agent 可以按服务端声明顺序加载多个单文件 Skill，要求名称唯一且每项精确解析一次。它适合规则、分类、抽取、改写、Prompt 编译和少量受控 Tool，但不会自动读取 Skill 的附加参考文件、运行 Skill 脚本、使用 MCP、保存持久记忆或看图后重试。

海报、CRT 与新闻图片流程都只让 Agent 编译 Prompt；Registration 校验结果后调用各自的窄 Rendering Capability。生产 HTTP Adapter 要求 Capability 返回已持久化图片的 URL。当前流程仍没有自动视觉检查、有限重绘或跨 Run 变化记忆；不要为了补齐这些能力直接开放 Coding Tools。

## Skill A/B 对比

实验比较三组路径：

1. 确定性 Direct 路径；
2. 使用透传控制 Skill 的 Agent；
3. 使用候选 `writing-clearly-and-concisely` Skill 的 Agent。

三组使用同一输入和 Business Capability。实验记录 Business Capability 实际收到的 Tool 入参，并检查候选 Skill canary、目标冗余短语、文本长度、Tool 调用次数和最终输出来源。

A/B 实验故意为每个 Agent arm 只绑定一个候选 Skill，以隔离变量；生产 `content-processing/v1` 使用前述两个 Skill。

先运行不调用模型的结构预检：

```bash
SKILL_AB_DRY_RUN=1 npm run test:skill-ab
```

再运行完整实验：

```bash
npm run test:skill-ab
```

用一次性环境变量覆盖模型时，仍要同时设置 provider 和 model：

```bash
PI_PROVIDER=openai \
PI_MODEL=gpt-5.6-terra \
npm run test:skill-ab
```

`passed: true` 表示结构和行为判据全部成立。真实实验把完整证据写入：

- `artifacts/skill-ab/latest.json`
- `artifacts/skill-ab/latest.md`

Dry run 不覆盖最近一次真实报告。实验只在临时目录生成 Skill 适配文件，结束后删除；第三方 Skill 原文件保持不变。

## 海报 Process 与 GPT Image 2

`minimal-zine-poster/v1` 的顺序由 [`src/processes/poster/registration.ts`](../src/processes/poster/registration.ts) 固定：Pi Agent 读取 `minimal-zine-poster-prompt`，返回四段 Prompt、六轴 recipe 和解释；Registration 完成结构与原文校验；Poster Rendering Capability 再生成并持久化图片。产品输入不包含 Skill、模型、Tool 或存储配置。

Runtime Skill 位于 `.pi/skills/minimal-zine-poster-prompt/`。它从上游 `gc-minimal-zine-poster-v0-1` 的固定哈希适配而来，只保留 Prompt 编译规则。`SOURCE.md` 记录来源、许可、审查清单、适配差异和回滚方式。Agent 没有 Tool；图片生成不属于 Skill 权限。

业务验收启动生产 Composition，通过产品 `POST /execute` 提交请求。生产 catalog 解析 Process 后，Pi Agent 编译 Prompt，生产 HTTP Adapter 再调用临时启动的受控 `POST /posters` Business Capability。该 Capability 通过所选 OpenAI 或 FAL Adapter 调用 GPT Image 2，并写入本地 raster；配置对象存储时上传并返回远端 URL，否则启动临时图片 endpoint。验收会下载 Process 返回的 URL，并逐字节比较下载结果与生成产物：

```bash
npm run accept:poster-business
# 兼容命令仍指向同一验收入口
npm run smoke:poster-process
npm run test:gpt-image-2
```

默认配置来自 `.env.example`。图片生成可能运行数分钟并产生费用；可用本地 `.env` 覆盖供应商、主题、尺寸、质量、格式和超时。OpenAI Adapter 调用 `/images/generations`；FAL Adapter 调用 `openai/gpt-image-2`，并用 `sync_mode` 取回内联图片。不要把 API Key 写入主题、Skill 或测试输入。

业务验收检查：

- 产品请求从 `POST /execute` 进入并返回 HTTP 200；
- production HTTP Adapter 恰好调用一次 `POST /posters`，并以 Process `runId` 作为幂等键；
- Process identity、`runId`、成功状态和 Runtime Skill 哈希；
- 四段 Prompt 结构、六轴 recipe 和 3:5 画幅；
- 留白、纸张、印刷细节和颜色锚点；
- 实际图片字节、格式、尺寸，以及从 Process 图片 URL 下载后的字节一致性。

结果写入：

- `artifacts/gpt-image-2/latest.<format>`
- `artifacts/gpt-image-2/latest.json`
- `artifacts/gpt-image-2/latest.md`

若 Agent 编译失败或输出不符合 Registration，Process 返回 `AGENT_FAILURE`，不会调用 Images Interface。若图片生成或持久化失败，Process 返回 `DEPENDENCY_FAILURE`。报告保留净化后的 Process 错误和仅供本地诊断的图片错误链；验收不使用代码 Prompt 或直接 Executor 绕过失败阶段。

## CRT 参考图编辑 smoke

`crt-interface-image/v1` 的产品契约、上传边界、`POST /crt-images` 协议、finalizer 和完整验收标准见 [`processes/common/crt-interface-image/`](processes/common/crt-interface-image/)。仓库当前提供一个更窄的付费 smoke，用来确认一张 PNG、JPEG 或 WebP 能通过所选 GPT Image 2 edit Adapter 生成 PNG：

```bash
CRT_SOURCE_IMAGE_FILE=/absolute/path/to/non-sensitive-test-image.png \
npm run smoke:crt-gpt-image
```

运行前必须配置所选图片供应商：OpenAI Adapter 读取 `OPENAI_IMAGE_API_KEY`，未设置时回退到 `OPENAI_API_KEY`；FAL Adapter 读取 `FAL_KEY`。源文件不得超过 50 MB；命令通过 magic bytes 判断格式，不把原图像素、Prompt 正文或凭证写入报告。可以用 `IMAGE_PROVIDER`、`CRT_IMAGE_MODEL`、`CRT_IMAGE_SIZE`、`CRT_IMAGE_QUALITY`、`CRT_IMAGE_TIMEOUT_MS` 和 `CRT_IMAGE_REPORT_DIRECTORY` 覆盖显式实验参数。FAL Adapter 只接受 `gpt-image-2`。`CRT_IMAGE_PROMPT` 只用于评审后的 Prompt 变更实验，不能成为产品字段。

产物包括：

- `artifacts/crt-interface-image/latest.png`
- `artifacts/crt-interface-image/latest.json`
- `artifacts/crt-interface-image/latest.md`

`passed: true` 只证明 edit stage 返回一张可解码、带尺寸的非平凡 PNG。它不证明主体完整、风格合格、调色板准确，也不运行 Runtime Skill Agent、production catalog、资产服务、确定性 CRT 后处理或对象存储。用下一节的本地业务验收检查完整本地链路。

## CRT 公网 URL 业务验收

确认参考图不敏感、所选供应商支持 GPT Image 2 编辑，并接受一次 Agent 与一次图片编辑用量后运行：

```bash
CRT_SOURCE_IMAGE_URL=https://images.example.com/source.png \
IMAGE_PROVIDER=fal \
FAL_KEY=replace-with-local-secret \
npm run accept:crt-business
```

命令临时启动回环 `POST /crt-images`，再从产品 `POST /execute` 调用 production catalog、真实 Agent、生产 HTTP Adapter、FAL GPT Image 2 和确定性 finalizer。验收默认启用 `full` 证据模式，并把摘要和本次 Run 的证据写入：

- `artifacts/crt-interface-image/acceptance/latest.png`
- `artifacts/crt-interface-image/acceptance/latest.json`
- `artifacts/crt-interface-image/acceptance/latest.md`
- `artifacts/crt-interface-image/acceptance/runs/<runId>/raw-gpt-image-2.*`
- `artifacts/crt-interface-image/acceptance/runs/<runId>/final-crt.png`
- `artifacts/crt-interface-image/acceptance/runs/<runId>/manifest.json`

临时服务关闭后删除工作目录；`full` 模式保留模型原始图、最终图和 manifest，`metadata` 只保留 manifest，`off` 不创建每次 Run 的证据目录。设置 `OBJECT_STORAGE_PROVIDER=aliyun-oss` 后还会把最终 PNG 上传 OSS；所需变量见 `.env.example`。`passed: true` 证明公网 URL 直传 FAL、单次图片编辑、`runId` 幂等、目标尺寸、精确调色板、证据策略和结果下载通过。

若 Agent 和图片阶段使用不同 API，可直连 OpenAI Images：

```dotenv
OPENAI_BASE_URL=https://chat-gateway.example/v1
OPENAI_API_KEY=replace-with-chat-key
OPENAI_IMAGE_BASE_URL=https://api.openai.com/v1
OPENAI_IMAGE_API_KEY=replace-with-images-key
```

未设置 `OPENAI_IMAGE_*` 时，图片阶段沿用 `OPENAI_*`。兼容网关仅在 `/models` 列出 `gpt-image-2` 不足以证明可用；运行付费验收前应确认它实现标准 `/images/edits` 路由。

兼容网关缺少 `/images/edits` 时，可让图片阶段改用 FAL：

```dotenv
IMAGE_PROVIDER=fal
FAL_KEY=replace-with-fal-key
```

FAL Adapter 固定调用 `openai/gpt-image-2` 与 `openai/gpt-image-2/edit`，把本地参考图编码为 Data URI，并设置 `sync_mode=true` 直接取回结果。供应商返回的 request ID 会进入本地报告；凭证、Prompt 正文、参考图像素和远端错误正文不会进入报告。生产采用 FAL 前必须评审图片数据保留、区域、费用、队列超时和删除要求。

## 新闻图片业务验收

`accept:news-image-business` 检出并运行当前代码的 production Composition，临时启动回环图片 Business API，再从正式 `POST /execute` 依次执行人物叙事碑式、淡彩绘本和原质人文主义三个准确版本。每个 Process 只允许一次图片生成；命令总计最多发起三次 Agent 调用、三次 FAL 图片生成和三次 OSS PUT。它固定使用 `gpt-image-2`、`low` 质量与服务端测试新闻，不接受调用方 Prompt、Skill、风格或图片配置。

该命令会产生费用和远端写入，运行前必须明确批准三次 Process Run、USD 上限、当前完整 commit SHA，以及允许读取的 OSS host/path prefix：

```bash
NEWS_IMAGE_ACCEPTANCE_COST_CONFIRMATION=APPROVE_THREE_NEWS_IMAGE_PROCESS_RUNS \
NEWS_IMAGE_ACCEPTANCE_COST_LIMIT_USD=1.00 \
NEWS_IMAGE_ACCEPTANCE_COST_APPROVAL_REFERENCE=release-ticket-123 \
NEWS_IMAGE_ACCEPTANCE_REVISION="$(git rev-parse HEAD)" \
NEWS_IMAGE_ACCEPTANCE_EXPECTED_OSS_HOST=assets.example.com \
NEWS_IMAGE_ACCEPTANCE_EXPECTED_OSS_PATH_PREFIX=/news-image/ \
PI_PROVIDER=openai \
PI_MODEL=gpt-5.6-terra \
IMAGE_PROVIDER=fal \
OBJECT_STORAGE_PROVIDER=aliyun-oss \
npm run accept:news-image-business
```

模型、FAL 与 OSS 凭证仍由本地 `.env` 或受保护 Environment 注入。成功证据只保存 revision、三个 Process identity、Run ID、固定 style、图片内容哈希、字节数、尺寸、访问结果、供应商类别和费用批准摘要；不保存固定测试新闻、Prompt、图片 URL、签名参数、模型响应或凭证。下载只允许配置的 HTTPS OSS host 和准确的 `news-image/<style>/<runId>.png` 路径，不跟随重定向。

`Production CI/CD` 的 Pull Request Job 不运行该付费验收，默认生产发布也直接跳过。显式把 Repository Variable `NEWS_IMAGE_ACCEPTANCE_ENABLED` 设为 `true` 后，`main` 候选只有修改新闻图片 Runtime Skill、共享 Agent Runtime、新闻图片 Process、图片 Business API、OSS/模型依赖或相关部署资源时，才进入 required-reviewer 管理的 `news-image-acceptance` Environment；批准后对同一 `github.sha` 运行验收，成功才允许生产部署。其他改动跳过该 Job。

## 阿里云 OSS 上传

对象存储默认关闭，图片只写入本地 `artifacts/`。要验证 OSS Adapter，在本地 `.env` 设置测试 bucket 和最小权限凭证：

```dotenv
OBJECT_STORAGE_PROVIDER=aliyun-oss
OSS_REGION=oss-cn-hangzhou
OSS_BUCKET=your-private-bucket
OSS_ACCESS_KEY_ID=your-ram-or-sts-access-key-id
OSS_ACCESS_KEY_SECRET=your-ram-or-sts-access-key-secret
OSS_URL_ACCESS=signed
OSS_SIGNED_URL_TTL_SECONDS=3600
```

优先使用 STS 临时凭证，并同时设置 `OSS_STS_TOKEN`。私有对象默认返回短期 GET 签名 URL；签名 URL 本身是 bearer credential，不要复制到 issue、聊天或公开报告。若 bucket 要求绑定的自定义域名，再设置 `OSS_ENDPOINT` 和 `OSS_CNAME=true`。公共或 CDN 分发使用 `OSS_URL_ACCESS=public` 与 `OSS_PUBLIC_BASE_URL`，代码不会修改 bucket ACL 或 CDN 权限。

海报业务验收启用 OSS 后，终端和报告会记录 bucket、object key、URL 访问方式和过期时间。对象键包含 Process `runId`；同一 Process Run 重试会写同一地址。独立 OSS smoke 另行记录 ETag 和 Request ID。

只验证 OSS、不重新调用模型时，先确认本地文件存在：

```bash
test -f artifacts/gpt-image-2/latest.png
npm run smoke:oss
```

可用 `OSS_SMOKE_FILE` 选择其他本地文件，用 `OSS_SMOKE_OBJECT_PREFIX` 限制对象前缀。完整结果写入 `artifacts/object-storage/latest.json`。

`ObjectStorageCapability` 只暴露内存字节上传 Interface。`AliyunOssStorage` 隐藏 SDK、签名、超时、URL 生成和安全错误转换。HTTP 服务没有任意文件上传入口；浏览器直传需要另行设计受鉴权的签名 PUT 流程和对象键策略。

## 已部署环境 smoke

`smoke:staging` 验证受控入口，不负责部署。运行前确认目标允许当前调用方访问，并使用短期认证值：

```bash
STAGING_SERVICE_BASE_URL=https://private-agent.example.internal \
STAGING_AUTHORIZATION='Bearer replace-with-short-lived-token' \
npm run smoke:staging
```

命令检查 `/healthz`、一次结构化成功结果和一次字段严格受限的 `INVALID_INPUT` 响应。它不比较精确文案，也不输出业务内容或认证值。发布顺序、容量门禁和回滚见 [`mvp-release-runbook.md`](mvp-release-runbook.md)。

## 解释结果

真实集成或业务验收报告只证明记录中的一次运行，不证明目标部署已正确配置。`minimal-zine-poster/v1` 与 `crt-interface-image/v1` 已进入 production catalog；上线前仍要确认：

- 产品需要的 Business Process 与稳定输入输出；
- Agent 或外部 Adapter 的超时、取消、错误和费用上限；
- Secret、业务内容、图片和 Run Record 的保留策略；
- 可通过窄 Interface 完成的确定性测试；
- 部署平台的认证、容量、观测和回滚方式。

新的实验能力仍须通过 Process Registration 显式进入 catalog；实验命令不能注册或改写生产流程。
