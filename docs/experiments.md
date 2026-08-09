# 实验与真实集成验证

本文面向验证 Agent、Skill、图片生成、对象存储和已部署环境的开发者。这些命令位于生产 HTTP catalog 之外，可能访问外部系统、产生费用或写入远端存储；默认测试套件不运行它们。

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
| `npm run test:gpt-image-2` | Skill Prompt 编译与真实图片生成 | 模型和 Images 请求，可选 OSS PUT | `artifacts/gpt-image-2/latest.*` |
| `npm run smoke:oss` | 已有文件的上传、URL 生成和首字节读取 | OSS PUT 与 GET | `artifacts/object-storage/latest.json` |
| `npm run smoke:staging` | 已部署环境的健康、成功与拒绝契约 | 受控环境请求 | 终端判据 |

## Pi Agent 路径

生产内容处理流程可以由服务端切换到 Agent 模式，产品请求和输出契约不变：

```bash
CONTENT_PROCESSING_MODE=agent npm run dev
```

Agent 每次请求创建独立内存会话，并把 `.pi/skills/content-optimization/SKILL.md` 与 `.pi/skills/content-integrity/SKILL.md` 作为一个固定 Skill 集合加载。Agent 只允许调用 `process_business_content`。这个 Tool 包装现有 Content Processing Capability；Shell、文件读写和代码编辑不会暴露给 Agent。

默认从 `.env` 读取 Pi 模型与 OpenAI 兼容配置。`PI_PROVIDER` 和 `PI_MODEL` 必须同时设置。`OPENAI_API_MODE` 可以是 `chat-completions` 或 `responses`；兼容网关还可通过 `OPENAI_BASE_URL` 配置。

先启动本地演示 Business Capability，再执行真实 Agent smoke：

```bash
BUSINESS_API_BASE_URL=http://127.0.0.1:4000 npm run smoke:agent
```

Smoke 会临时启动 Agent 模式服务，完成一次 `/execute` 请求，并确认 Agent 实际调用了 Business Capability。它不输出业务内容或 Tool 入参，但可能产生模型费用。

### 当前 Skill 执行范围

生产 Agent 可以按服务端声明顺序加载多个单文件 Skill，要求名称唯一且每项精确解析一次。它适合规则、分类、抽取、改写、Prompt 编译和少量受控 Tool，但不会自动读取 Skill 的附加参考文件、运行 Skill 脚本、使用 MCP、保存持久记忆或看图后重试。

海报实验只让 Agent 编译 Prompt；图片生成、视觉判据和对象存储由代码控制。要把完整视觉质量门加入生产流程，应另行增加窄图片生成 Capability、视觉检查、有限重试和持久化产物。不要为了运行复杂 Skill 直接开放 Coding Tools。

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

## GPT Image 2 与海报 Skill

图片实验按固定顺序执行：Pi Agent 读取 `gc-minimal-zine-poster-v0-1` Skill，把业务主题编译成四段图片 Prompt；代码随后调用 Images Interface；最后检查 raster bytes、尺寸和 Prompt 判据。启用对象存储后，同一命令还会通过 `ObjectStorageCapability` 上传图片。

运行真实测试：

```bash
npm run test:gpt-image-2
```

默认配置来自 `.env.example`。图片生成可能运行数分钟并产生费用；可用本地 `.env` 覆盖主题、尺寸、质量、格式和超时。不要把 API Key 写入主题、Skill 或测试输入。

实验检查：

- Skill 文件哈希和 Prompt 来源；
- 四段 Prompt 结构、六轴 recipe 和 3:5 画幅；
- 留白、纸张、印刷细节和颜色锚点；
- 实际图片字节、格式和尺寸。

结果写入：

- `artifacts/gpt-image-2/latest.png`
- `artifacts/gpt-image-2/latest.json`
- `artifacts/gpt-image-2/latest.md`

若 Agent 阶段失败，命令仍使用代码内的基准 Prompt 调用 Images Interface，以区分 Agent/Skill 故障与图片 Adapter 故障；这种降级只用于诊断，最终结果仍为 `FAIL`。

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

图片实验启用 OSS 后，终端和报告会记录 bucket、object key、URL 访问方式、过期时间、ETag 和 Request ID。对象键基于图片内容哈希；重复上传相同图片会使用同一地址。

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

实验报告是一次运行的证据，不是生产能力声明。判断是否把实验能力加入 production catalog 前，还要明确：

- 产品需要的 Business Process 与稳定输入输出；
- Agent 或外部 Adapter 的超时、取消、错误和费用上限；
- Secret、业务内容、图片和 Run Record 的保留策略；
- 可通过窄 Interface 完成的确定性测试；
- 部署平台的认证、容量、观测和回滚方式。

满足这些条件后，新能力仍应通过 Process Registration 显式进入 catalog，不能由实验命令自动注册。
