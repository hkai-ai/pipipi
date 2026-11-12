# Business Processing Service

一个轻量的版本化业务处理服务。产品调用方只提交 Business Process、准确版本和业务输入；服务端用代码绑定 Schema、业务行为、获准依赖和稳定策略。流程内部可以使用本地逻辑、远程 Business Capability 或受限 Agent，产品契约不随实现方式变化。

## 当前能力

模板制作的新方案默认保留原图的透明区域，明确指定的背景要求优先。背景随方案批准固定，旧方案需重新规划才能匹配原图。

图片预处理后的模板内容支持独立重编译：保留已确认成图，提交本轮模板修改要求，只生成新的 Gallery 草稿供人工审阅。

生产 catalog 登记二十七个 Business Process，其中 `composed-task/v1` 默认关闭。文档先按产品场景分组，运行时仍通过统一的 Process identity 和 HTTP Interface 执行：

| 场景 | Process | 输入 | 输出 |
| --- | --- | --- | --- |
| `memebuy` | `template-from-image/v1` | `{ imageUrl, note? }` | `{ template }`，Gallery v2 草稿 |
| `memebuy` | `template-image-plan/v1` | 原图与备注 | 待审替换方案 |
| `memebuy` | `template-image-render/v1` | 方案批准 | 中转站成图的待审完整 PNG；历史 FAL 按原请求恢复 |
| `memebuy` | `template-from-source/v1` | 成图批准 | 新图引用与模板草稿 |
| `common` | `minimal-zine-poster/v1` | `{ "brief": string, "text"?: string }` | `{ "prompt", "recipe", "interpretation", "image" }` |
| `common` | `crt-interface-image/v1` | `{ "sourceImageUrl", "palette", "aspectRatio" }` | `{ "aspectRatio", "image" }` |
| `memene` | `news-image-narrative-monument/v1` | `{ "title", "summary" }` | `{ "style", "image" }` |
| `memene` | `news-image-pale-watercolor/v1` | `{ "title", "summary" }` | `{ "style", "image" }` |
| `memene` | `news-image-raw-humanism/v1` | `{ "title", "summary" }` | `{ "style", "image" }` |
| `common` | `composed-task/v1`（默认关闭） | `{ "goal", "material"?, "constraints"? }` | `{ "summary", "steps", "result" }` |
| `common` | [`dopamine-photo-poster/v1`](docs/processes/common/dopamine-photo-poster/README.md) | 公网参考图与可选文案 | `{ style, image }` |
| `common` | [`mono-color-photo-poster/v1`](docs/processes/common/mono-color-photo-poster/README.md) | 公网参考图与可选文案 | `{ style, image }` |
| `common` | [`mono-color-photo-poster/v2`](docs/api.md#双色海报-v2) | 参考图、最终两墨及版式参数，可选素材摘要、文案与背景；Flare 编辑成图 | `{ style, image }` |
| `common` | [`travel-abstraction-photo-poster/v1`](docs/processes/common/travel-abstraction-photo-poster/README.md) | 公网参考图与可选文案（必填 phrase） | `{ style, image }` |
| `common` | [`crayon-photo-poster/v1`](docs/processes/common/crayon-photo-poster/README.md) | 公网参考图与可选文案 | `{ style, image }` |
| `common` | [`monochrome-photo-poster/v1`](docs/processes/common/monochrome-photo-poster/README.md) | 公网参考图与可选文案 | `{ style, image }` |
| `common` | [`woodcut-photo-poster/v1`](docs/processes/common/woodcut-photo-poster/README.md) | 公网参考图与可选文案 | `{ style, image }` |
| `common` | [`photo-doodle-collage/v1`](docs/processes/common/photo-doodle-collage/README.md) | 公网参考图与可选文案 | `{ style, image }` |
| `common` | [`photo-fashion-manga/v1`](docs/processes/common/photo-fashion-manga/README.md) | 真人参考图与可选主标题、引题、小注，原始手刻字风格与随图构图 | `{ style, image }` |
| `common` | [`manga-panels/v1`](docs/processes/common/manga-panels/README.md) | 参考图与固定预设，输出无文字三格漫画 | `{ style, image }` |
| `common` | [`memory-checklist-photo-poster/v1`](docs/processes/common/memory-checklist-photo-poster/README.md) | 一张参考图，上半保留原片、下半 3×3 蜡笔记忆点 | `{ style, image }` |
| `common` | [`risograph-album/v1`](docs/processes/common/risograph-album/README.md) | 一张人物照片，输出 1200×1200 复古唱片封面 | `{ style, image }` |
| `common` | [character-emoji/v2](docs/processes/common/character-emoji/README.md) | DeepSeek 4.1 Flash Pi Agent 按模式加载 Skill、默认使用本地素材或原创，按需调用 DeepSeek 搜梗 Tool，经 Memene GPT Image 2.5 Flare（报错后尝试一次 Magikaru，取消或总截止除外） 生成单图表情或多格漫画 | `{ image, mode, caption?, plan }` |
| `common` | `character-emoji/v3` | 同角色双版本登场、版本化对白及新版场景参考图，最多 5 位 | `{ image, mode, caption?, plan }` |
| `common` | [character-emoji/v4](docs/api.md#角色表情包) | 按冻结角色资料生成单图或漫画，图片响应丢失时按原运行核验 | `{ image, mode, caption?, plan }` |

Memebuy 场景已登记 `template-from-image/v1`，可在 Pipipi 独立编译图片模板草稿；Memebuy 改由模板素材箱的提取 Worker 接入，候选需人工确认后保存草稿，部署与真实页面验收另行完成。Pipipi 独立测试与 JSON 下载保留。场景入口和归属规则见 [`docs/processes/README.md`](docs/processes/README.md)。

`composed-task/v1` 由 `COMPOSED_TASK_ENABLED=true` 开启：一个 Planner Agent 在服务端预算内组合固定 allow-list 中的七个 Process（不含照片海报），每一步仍走对应 Process 自己的校验与治理，调用方只提交目标与素材。

全部流程共享同一个 `POST /execute` Interface。每个明确版本由 Process Registration 绑定业务定义、Schema、依赖、运行活动和策略，再进入不可变 Process Registry。Process Runner 统一处理 `runId`、精确版本查找、超时、取消、错误净化和可选 Run Record。

每次 Process Attempt 都输出不含业务内容的结构化活动日志。可选 Run Record 保存终态与活动归档，但只用于观测，不决定业务状态。运维控制台提供用量概览、精确版本记录筛选、异常聚合与失败活动排查，开发工具保留目录浏览和异步提交；Vite + Preact 页面随 API 发布，Worker 角色保持独立。它没有应用内鉴权，生产访问控制由部署平台负责。详细语义见 [Process Runtime 设计](docs/process-runtime-design.md)。

生产启动通过 Installed Skill Catalog 校验 Runtime Skill 的准确名称、版本和 SHA-256。Process 只加载 Registration 固定绑定的 Skill 与窄 Tool；运行期不发现、下载或更新 Skill。

Agent Conversations 框架提供多轮文本、owner-scoped 图片和受控 Process Tool 能力，但 production Agent catalog 当前为空：原 `design-assistant/v1` 已下线，待重新开发后再登记，此时开启 `AGENT_CONVERSATIONS_ENABLED=true` 会在启动时失败。调用方只提交准确 Agent、`afterTurnId`、文本和稳定图片 `resourceId`；服务端 Registration 固定 Runtime Skill、Context/Memory 策略、模型、Tool allow-list、预算、输出与保留。PostgreSQL 保存权威 Turn、幂等、`configRevision`、执行 claim、Outbox 与 Tool Ledger；BullMQ 只投递最小 Turn identity，Dispatcher、Worker 与 Reconciler 通过 lease、revision 和 fencing 处理重投、Worker 中断及 Queue 重建。priced Tool 用稳定子 Run、执行 token 和 after-commit 语义避免重启后重复扣费。owner 可删除 Conversation；30 天闲置期限、立即 fencing、最迟 24 小时物理清理和可续跑 Cleaner 已实现。`AGENT_CONVERSATIONS_ENABLED=false` 使默认部署仍返回 404；受控启用见 [Agent Conversations Runbook](docs/agent-conversations-runbook.md)，公开契约见 [Agent Conversations API](docs/api.md#agent-conversations多轮文本与图片资源)。

通常图片 Process 只公开业务输入和图片引用；模板图片生产向受信任的运营调用方提供待审策略与完整 PNG。Prompt、模型、供应商、Skill 和存储配置留在服务端。内部新闻图片评测默认关闭，只在受控环境复用同一次正式 Process 执行。

## 按 Business Process 查看

每个 production Process 都有独立文档目录。先从对应目录确认产品契约、执行顺序、依赖、错误和验证入口，再进入 Implementation：

| 场景 | Process 文档 | 主要 Registration |
| --- | --- | --- |
| [`common`](docs/processes/common/) | 海报与 CRT 图片 | [`src/processes/`](src/processes) |
| [`memene`](docs/processes/memene/) | 三个新闻图片 Process | [`src/processes/news-image/registration.ts`](src/processes/news-image/registration.ts) |
| [`memebuy`](docs/processes/memebuy/) | 图片转可编辑模板 | [`src/processes/template-from-image/registration.ts`](src/processes/template-from-image/registration.ts) |

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

`.env` 已被 Git 忽略。执行海报业务验收或真实模型 smoke 时需要模型凭证。不要把真实凭证提交到仓库。

生产预检、Compose 形状、异步发布和付费 smoke 不属于快速开始。部署前分别阅读 [同步发布手册](docs/mvp-release-runbook.md)、[异步发布手册](docs/async-process-runs-runbook.md) 与 [Agent Conversations Runbook](docs/agent-conversations-runbook.md)。

只开发调用方的多轮文本接入时，运行 `npm run dev:agent` 即可在 `127.0.0.1:4300` 获得四个正式 v1 Conversation 路由。该开发入口使用固定 Scripted Agent（沿用 `design-assistant/v1` 作为调用方契约桩，不是生产 Agent）和内存 Adapter，不需要 PostgreSQL、Redis 或模型凭证；默认 Bearer Token、请求示例和限制见[开发指南](docs/development.md#本地开发)。

在第一个终端启动内部图片 Business API：

```bash
npm run dev:business-api
```

极简海报、CRT 与其他图片 Process 通过必填的 `CRT_BUSINESS_API_BASE_URL` 使用该服务。它默认监听 `127.0.0.1:4400`，需要已有的 FAL 和 OSS 配置；实际执行图片请求会产生费用和存储写入。极简海报的 `POST /posters` 已纳入该服务，正式启动不依赖验收脚本。全部产品调用契约见 [`docs/api.md`](docs/api.md)。

在第二个终端启动处理服务：

```bash
npm run dev
```

不付费地验证 `/execute` 链路时，提交一个不满足 Schema 的请求；服务在调用 Agent 或图片服务前返回 `400 INVALID_INPUT`：

```bash
curl -X POST http://127.0.0.1:4300/execute \
  -H 'content-type: application/json' \
  -d '{
    "process": "minimal-zine-poster",
    "version": "v1",
    "input": {}
  }'
```

每个响应都包含独立 `runId`；有效输入会调用模型并生成图片，产生费用和存储写入。

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

## 照片海报模板

模型错误使用统一分类：照片海报、极简海报、CRT、新闻图片、内容优化及模板编译在稳定错误码之外提供阶段、中文原因和排查建议。控制台关联脱敏活动诊断，模板父运行详情可查看编译子运行的字段和规则，旧记录不补推根因。超时、取消与未知异常分别收口；实现和工具选择见 [统一诊断](docs/process-runtime-design.md#统一诊断与工具选择)。 公开错误仅解释阶段和已知原因，运维建议留在控制台；公开文案只额外保留禁止重复付费提交等调用方约束。控制台的依赖失败标题和下一步由公开错误码决定，活动诊断补充阶段与字段。默认内部诊断不覆盖已知业务错误；已恢复的活动失败不作为最终原因，成功摘要不包含失败诊断。

Mono Color v2 读取 Memebuy 建单时冻结的两墨与完整设计搭配；v1 保留五个可编辑预设供历史调用。每种版式明确标题用色、分行与穿插关系，默认干净近白纸底和细网点，保留参考主体与动作；未提供新参数的调用保持原行为。字段见 [Mono Color API](docs/api.md#mono-color-可编辑预设)。

现有七个照片海报 Process：多巴胺、双色油墨、旅行抽象、彩色蜡笔、黑白蜡笔、木刻，以及摄影剪贴与涂鸦小人。一次请求处理一张公网 HTTPS 照片，返回持久化 PNG 引用；调用方式见 [照片海报 API](docs/api.md#照片海报)，来源与适配见 [通用 Process](docs/processes/common/)。它们均只返回完整风格化成品，不附原图或上下对照；旅行抽象仅由代码补充档案字样。摄影剪贴与涂鸦小人当前已注册，尚未部署。

图片转模板的 `promptTemplate` 是用户可编辑的草稿业务内容，可以随正式结果返回；内部编译指令、复核证据和模型配置仍不返回。

图片转模板按原 Skill 保留逐区文字分类、布局、位置和路由依据，原始观察与选定稳定规则分开保存；共同语义模型生成正式草稿，由独立复核核对。保留完整来源业务规则，槽位取舍直接复用来源原文并复核未入选候选，重复事实由服务端引用投影，内部执行“生成分析与草稿 → 独立看图复核并返回必要补丁 → 程序投影与完整校验”。正常两次模型调用，仅首轮 JSON 或候选结构无法读取时允许一次重新编译，最多三次；独立复核不重写完整候选，也不默认追加模型复核，部分分析采用紧凑行，特征权限及复核报告采用具名对象；九轴权限只要求身份替换槽位提供，其他槽位为 null。证据按来源要求非空且具体，不额外设置四字符下限。修正上下文直接读取引用计划，程序展开后执行完整校验。公开 Gallery v2 草稿合同保持不变；执行失败区分编译、独立复核和本地校验阶段，仅返回安全归类提示。实现与边界见 [图片转模板](docs/processes/memebuy/template-from-image/README.md)。

图片替换方案在原 240 秒预算内允许一次字段补丁修正，完整复验后才交给人工确认；失败阶段和固定规则可诊断。详见 [方案校验与修正](docs/processes/memebuy/template-image-plan/README.md)。

图片预处理在同一次请求中结合原图总览与有界局部细节，先逐区观察文字几何再决定替换；按原 Producer 的排版、冻结与特征权限生成并固定十二段简洁生图指令，字段修正携带目标 Schema，保留两次人工审核；明确拒绝与未知提交分别保存，批准不可复用。旧方案兼容与审核展示见 [模板图片预处理](docs/processes/memebuy/template-from-source/README.md)。

Memebuy 模板分步制作支持同方案多个成图版本：新 `renderId` 明确重做，同一身份仅恢复；图片审批绑定实际版本，旧单图合同兼容。接口见 [业务 API](docs/api.md)。

CRT 与七个照片海报支持可选背景参数，省略时保持原行为；透明成品在交付前校验。取值与调用方式见 [图片背景参数](docs/api.md#图片背景参数)。

角色表情包构思包含单图与漫画；同一个 DeepSeek 4.1 Flash Pi Agent 首轮接收按角色和题材挑选的本地短卡，可改编或原创，服务端仅对明确检索或近期事实要求开放搜索工具，普通创作没有搜索工具；开放后可从 DeepSeek 返回的最多两个候选中选材，以 low 推理预算构思并自检，JSON格式、可定位结构或台词错误共用一次原会话修正机会。搜索失败直接原创，未核验资料可作灵感；搜索最多30秒，资料精简后交给 Agent；程序校验同次材料身份，可读取候选修正时冻结未报错字段，按角色 ID 绑定参考图，仅生成编号，保留 Agent 的自由布局；允许少量场景辅助文字，单图白底贴纸为默认风格；画面语义仍需验收，见[角色表情包说明](docs/processes/common/character-emoji/README.md)。 构思及修正采用上游默认输出额度，不发送输出 token 上限，仍保留120秒共享截止时间。

角色表情包主用 Flare 复用已配置的 OSS 读取固定角色原图，不缩放、不压缩，按原顺序通过 multipart 文件表单上传；独立本地运行未配置 OSS 时才使用公网取图。Flare 对齐已核验的 Memebuy 请求，省略 quality 和 output_format，不继承 CRT 参数；备用 Magikaru 保持公网 URL 直传及原有质量参数。角色表情包按所选角色注入已维护的创作背景；v2 漫画由 Agent 决定自由布局和各格大小，程序仅补编号。每格仍只有一份 scene；page 与 frame 只描述画格几何，关键行动或可辨认痕迹在 scene 呈现，同次自检核对肢体占用与道具支撑；配字优先级及创作规则见[角色表情包专题](docs/processes/common/character-emoji/README.md)。

豆包支持 Q 版（`Doubao:Chibi`），调用示例见[角色表情包 API](docs/api.md#角色表情包)。

## 模板视觉归属 v3

新增 `template-from-image/v2` 与 `template-from-source/v2`，输出 `runtimeSemantics.version=3`；`inputSchema.version` 仍为 2。目标外观写入 `targetInstances[].appearance`，姿势与位置写入 `pose`，全局视觉合同只保留非目标事实。旧 v1 接口继续输出运行语义 v2，恢复既有运行不切换版本。两端发布与验收见 [模板归属升级](docs/processes/memebuy/template-from-image/visual-ownership-v3.md)。

## 模型网关配置

文本模型网关由 Composition Root 统一解析：优先使用完整的 `MODEL_GATEWAY_BASE_URL` / `MODEL_GATEWAY_API_KEY`，两者都未配置才依次兼容 TEXT_MODEL、CHARACTER_EMOJI、OPENAI 旧网关整对配置。表情包构思与搜梗也复用同一对；旧 PLANNER 网关覆盖不再生效。模型、协议与调用预算保持各 Registration 原定义，共享网关也作为图片默认凭证；图片渠道启用与主备策略独立，详见配置说明。

模板制作工作台可随同步回执保存脱敏步骤，也可按原运行查询保留期内的父流程与编译成员记录；见[模板执行步骤](docs/api.md#模板执行步骤)。
