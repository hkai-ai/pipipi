# Business Processing 项目上下文

本文记录项目长期稳定的业务背景、范围和共同语言。它帮助产品、开发者和自动化工具在修改代码前建立同一套理解；安装命令、实现细节和发布步骤分别放在对应专题文档中。

## 项目目的

Business Processing Service 让产品调用方通过一个稳定的 HTTP Interface 执行版本化的业务处理。调用方只需选择明确的 Business Process 版本并提交业务输入，不需要知道流程内部使用本地逻辑、远程 Business Capability，还是受限 Agent。

项目要解决的核心问题是：让实现方式可以演进，同时让产品契约保持明确。服务端集中拥有 Process Definition、输入输出 Schema、获准依赖和运行策略，避免这些知识散落到每个调用方。

## 产品场景

仓库服务多个产品场景。Memene 当前拥有三个新闻图片 Business Process；Memebuy 是独立产品边界，当前尚无明确归属的 production Process；跨产品原样复用或契约本身与产品无关的 Process 归入 `common`。场景归属组织代码阅读与文档，不改变 Process identity、版本或统一 HTTP Interface。

新增 Process 时先确认调用产品。产品专属契约进入 `docs/processes/<product>/`；多个产品共享同一准确契约时进入 `docs/processes/common/`。当前归属以 [`docs/processes/README.md`](docs/processes/README.md) 为入口。

## 产品契约

调用方必须知道：

- Business Process 的标识和准确版本；
- 该版本的输入、输出和公开错误；
- 同步请求可能超时，容量已满时应按 `Retry-After` 重试；
- 使用异步 Interface 时必须提供 caller-scoped `Idempotency-Key`，并用返回的 `runId` 查询公共状态。

服务端负责决定：

- Process Definition 及其执行顺序；
- Schema、Business Capability、Agent、Skill 和 Tool；
- 超时、并发、记录和错误净化策略；
- 哪些 Process Registration 进入生产 Process Registry。

产品调用方不能上传步骤、脚本、模型、Skill、Tool、远程地址或运行配置。

开发者可以在 authoring 阶段向 Codex 提供自然语言流程描述，或提供 Skill 的本地路径、Git 仓库和网页地址。Codex 必须先把它们收敛为经过审查、固定版本且由服务端拥有的代码或本地资源，再通过明确的 Process Registration 发布；这些 authoring 输入不会成为产品契约。具体流程见 [`docs/authoring-business-processes.md`](docs/authoring-business-processes.md) 和 [`docs/integrating-runtime-skills.md`](docs/integrating-runtime-skills.md)。

## 当前能力

生产 catalog 当前注册七个精确版本：

| 场景 | Business Process | 输入 | 输出 | 实现选择 |
| --- | --- | --- | --- | --- |
| `common` | `content-processing/v1` | `{ content: string }` | `{ content: string }` | 服务端可选择 Direct 或绑定多个 Runtime Skill 的 Agent 路径 |
| `common` | `titled-content-processing/v1` | `{ title: string, body: string }` | `{ title: string, content: string }` | 复用 Content Processing Capability |
| `common` | `minimal-zine-poster/v1` | `{ brief: string, text?: string }` | `{ prompt, recipe, interpretation, image }` | 无 Tool Agent 编译固定 Runtime Skill；Poster Rendering Capability 生成并持久化图片 |
| `common` | `crt-interface-image/v1` | `{ sourceImageUrl, palette, aspectRatio }` | `{ aspectRatio, image }` | 无 Tool Agent 编译固定 Runtime Skill；CRT Rendering Capability 用公网 HTTPS 参考图执行 FAL GPT Image 2 编辑、后处理并持久化 PNG |
| `memene` | `news-image-narrative-monument/v1` | `{ title, summary }` | `{ style, image }` | 固定人物叙事碑式封面 Runtime Skill |
| `memene` | `news-image-pale-watercolor/v1` | `{ title, summary }` | `{ style, image }` | 固定淡彩绘本 Runtime Skill |
| `memene` | `news-image-raw-humanism/v1` | `{ title, summary }` | `{ style, image }` | 固定原质人文主义 Runtime Skill |

生产 Composition Root 通过 Installed Skill Catalog 校验七个 Runtime Skill 的准确名称、版本和 SHA-256。Process 只绑定通过校验的准确版本；Catalog 不发现、下载或更新 Skill。

默认 HTTP Interface 提供健康检查和同步 `POST /execute`。异步提交、owner 查询、PostgreSQL Store、BullMQ Worker、Webhook、恢复和保留已经实现，但入口默认关闭。精确行为见 [异步设计](docs/async-process-runs-design.md)。

海报、CRT 和 Memene 新闻图片 Process 会调用模型并持久化图片。产品只接收图片引用；真实验收、证据与费用必须显式启用。CRT 和新闻图片上游来源的许可证仍是发布门禁。

## 运行与信任模型

默认发布是受控、同步的 Node.js HTTP 服务；异步入口默认关闭。部署平台负责 TLS、私有入口、调用方认证、实例上限和 Secret 注入。生产形状、门禁与回滚由 [同步 Runbook](docs/mvp-release-runbook.md) 和 [异步 Runbook](docs/async-process-runs-runbook.md) 拥有。

显式启用异步入口后，PostgreSQL 保存权威 Process Run，Redis/BullMQ 只负责调度。API、Dispatcher、Process Worker、Webhook Worker 和 Retention Cleaner 是独立角色。Queue 只承诺至少一次投递；Business Capability 使用稳定 `runId` 控制重复副作用。网关删除调用方伪造的身份头，并注入稳定 caller subject；查询、幂等和 Webhook 按 owner 隔离。

Run Observation Module 同时服务同步 API 和异步 Worker。Run Record 与活动日志只用于观测，不决定业务状态、重试或投递；写入失败不能改变 Process Result。异步调用方始终通过 owner-scoped Process Run Store 查询权威状态。

Agent 只获得 Registration 固定绑定的 Runtime Skill 与窄 Tool。文本 Agent 只能调用 Content Processing Capability；海报、CRT 和新闻图片 Agent 没有 Tool，只编译待校验计划。Agent 不获得 Shell、文件读写、代码编辑或任意远程工具。Runtime Skill 随应用发布，调用方不能选择、增加或排序。

图片 Process 的模型、FAL、OSS、证据和保留策略由服务端 Adapter 与部署环境拥有。产品只提交业务字段并接收图片引用。真实模型、存储和付费验收必须显式运行，凭证与敏感内容不进入日志、正式输出或证据。

## 当前不做

项目当前不提供：

- 动态 Process Definition、运行时注册、自动发现、默认版本或版本回退；
- 通用工作流编排、已开放的生产 Queue、跨请求 Agent 记忆或调用方控制的重试；
- 应用内用户系统、RBAC、多租户、CORS 或公网匿名调用；
- 运维控制台的应用内鉴权、按 caller 隔离的记录视图、聊天历史或通用幂等；
- 允许 Agent 使用 Coding Tools 的通用 Skill 执行环境；
- `minimal-zine-poster/v1` 的参考图片输入，以及任一图片流程的自动视觉检查、跨 Run 变化记忆或自动重绘。

`minimal-zine-poster/v1` 与 `crt-interface-image/v1` 会产生模型费用和图片持久化副作用。海报 Registration 不重试 Agent；CRT Registration 可以在任何图片调用前重试一次无副作用的 Agent 编译。两个 Registration 都只调用一次图片 Capability，并把稳定 `runId` 作为下游幂等键；部署方仍须限制调用权限、并发、超时和费用。CRT 流程还处理用户上传资产，必须在产品图片服务中明确所有权、保留、删除和敏感内容策略。新增发布、扣费、发送等副作用前，必须先明确幂等、审计和补偿策略。

异步执行能力已经实现但默认关闭。开放任何外部异步流量前，部署方必须完成身份、容量、恢复、安全、观测和 staged rollout 门禁。

## Module 模型

项目把复杂行为放在少量稳定 Interface 后面：

| Module | 外部 Interface | 隐藏的 Implementation |
| --- | --- | --- |
| Startup Construction | `constructProcessingService(environment)` | 配置翻译、校验、Adapter 选择和完整生产组装 |
| Async Role Construction | `constructProcessDispatcherService`、`constructProcessWorkerService`、`constructRetentionCleanerService` | 角色专属配置、依赖和生命周期组装 |
| Processing Application | `listen`、`close` | Node HTTP 生命周期 |
| Process Executor | `execute(request)` | 查找、超时、取消、错误转换和 Run Record |
| Process Registration | `identity`、`retryPolicy`、`accept(input)`、`run(acceptedInput, context)` | Schema、JSON-safe accepted input、Process Definition、依赖、服务端重试策略和输出验证 |
| Process Attempt Runner | `run({ runId, registration, acceptedInput, attemptNumber? })` | 预分配 runId、超时、取消、公开错误净化和活动时间线 |
| Process Run Activity Logging | `runActivity(name, operation)`、`ProcessRunLogSink` | 声明检查、Attempt 关联、顺序、耗时、结果净化，以及 Pino 与内存 Adapter |
| Async Process Runs | `submit(request, context)`、`find(runId, context)` | 输入接受、owner、幂等摘要和公共状态投影 |
| Console Process Run Client | `execute(request, options)`、`pending()`、`dismiss()` | 浏览器 transport、稳定幂等操作、请求摘要、本地恢复状态、轮询、运行时响应校验、同源结果地址与结构化页面结果 |
| Async Operations | `snapshot()`、staged release readiness | PostgreSQL 与 BullMQ 指标、容量/恢复发布门禁和无内容结构化日志 |
| Process Run Store | 接受 Run、owner 查询、claim、终态转换 | accepted input、attempt、revision 和 fencing；提供内存与 PostgreSQL Adapter |
| Process Work Queue | `enqueue({ schemaVersion, runId })`、`close()` | 去重、容量和调度；提供确定性内存与 BullMQ Adapter |
| Outbox Dispatcher | `dispatchOnce()` | PostgreSQL claim、BullMQ publish、ack 与失败 release |
| Process Run Reconciler | `reconcileOnce()` | 长期 queued 与过期 running Run 扫描、最小 Job 重投 |
| Process Recovery | `recover({ mode, dryRun, cursor })` | Queue 缺失检查、Outbox 对账、租约分类、修复审计和批次指标 |
| Process Worker | `process(job)` | exact Registration 查找、Attempt 执行和受控状态转换 |
| Runtime Role Application | `listen`、`close` | Dispatcher/Worker liveness、readiness 和 HTTP 生命周期 |
| Webhook Delivery | `claim`、`reschedule`、`complete`、`replay` | 加密 Endpoint、固定公网目标、Standard Webhooks 签名、Attempt 审计和重放 |
| Retention Cleaner | `runSweep({ asOf, cursor, signal })` | 分层期限、短事务批次、引用保护、审计和游标续跑 |
| Business Capability | 窄业务方法 | 远程协议、认证、超时和供应商细节 |

Startup Construction 是生产组装 Seam；Process Executor 是同步传输与 Process Runtime 之间的主 Seam；Async Process Runs 是异步 HTTP 与权威 Store 之间的主 Seam；Console Process Run Client 是浏览器页面与异步 HTTP Interface 之间的主 Seam；Process Registration 是编写一个 Business Process 版本的 Seam；Process Attempt Runner 让同步入口和异步 Worker 复用同一执行治理。Adapter 只有在 Seam 上存在真实替换需求时才引入。

详细 invariant、错误归属和测试面见 [`docs/process-runtime-design.md`](docs/process-runtime-design.md)。

## 共同语言

- **Business Process**：产品调用方可执行的版本化业务用例。避免使用：Workflow、pipeline。
- **Process Definition**：由代码拥有的某个 Business Process 版本的业务行为与契约。避免使用：Workflow definition、process configuration。
- **Process Registration**：经过校验、可执行的单个 Business Process 版本。它把 Process Definition、获准依赖和服务端策略绑定在一起。避免使用：registry entry、raw Process Definition。
- **Process Registry**：不可变的 Process Registration catalog，以 Business Process 标识和版本寻址。它只做精确查找，不选择默认或回退版本。避免使用：process map、process list。
- **Process Runner**：治理一次已解析 Process Registration 执行的 Runtime。它统一处理运行规则，但不知道具体流程的策略或依赖形状。避免使用：workflow engine、Process Registry。
- **Execution Context**：Process Runner 在输入被接受后提供的请求级元数据。它只包含 `runId`、`AbortSignal` 等运行信息；获准依赖和稳定策略属于 Process Registration。避免使用：global capability bag、dependency bag。
- **Business Capability**：Process Definition 获准调用的窄业务能力。远程协议或供应商 SDK 留在 Adapter 的 Implementation 内。
- **Process Run**：一个 Business Process 的执行实例，以独立 `runId` 标识。同步入口在请求内返回终态；异步入口在持久化接受后允许跨请求查询。
- **Process Attempt**：异步 Worker 对同一个 Process Run 的一次执行尝试。重试产生新 Attempt，但不产生新 Process Run。
- **Queue Job**：唤醒异步 Worker 的内部调度消息。它不是产品任务、Process Run 或权威状态，不进入公开 Interface。
- **Process Event**：Process Run 状态变化后产生的不可变事实，可投影为 Webhook payload。
- **Webhook Delivery**：一个 Process Event 向一个已注册 Webhook Endpoint 的投递记录。重复 Delivery 是正常的至少一次语义。
- **Run Record**：一次 Process Run 的派生观测元数据。它不参与状态转换或恢复，不是聊天记录，也不应默认保存业务内容或 Agent 内部过程。
- **Process Run Activity Log**：一次 Process Attempt 的 best-effort 结构化观测时间线。活动名由 Process Registration 固定声明；它不是 Process Event、权威状态、业务审计或隐藏推理。

设计讨论统一使用 **Module**、**Interface**、**Implementation**、**Seam** 和 **Adapter**。Interface 包含调用方必须知道的全部约束，不只包含 TypeScript 类型。

## 事实来源

| 问题 | 主要来源 |
| --- | --- |
| 项目为何存在、范围和术语 | 本文 |
| 项目是什么、如何完成最短体验 | [`README.md`](README.md) |
| 全部业务调用路由、请求、响应和错误 | [`docs/api.md`](docs/api.md) |
| Agent 可直接读取的生产调用入口 | [`llms.txt`](llms.txt)，并由 `/llms.txt` 公开提供 |
| 精确运行行为和公开错误 | `src/` 与 `test/` |
| Module、Interface、invariant 和测试面 | [`docs/process-runtime-design.md`](docs/process-runtime-design.md) |
| 异步提交、查询、Queue 与 Webhook 设计 | [`docs/async-process-runs-design.md`](docs/async-process-runs-design.md) |
| 异步本地开发与验证 | [`docs/async-process-runs-development.md`](docs/async-process-runs-development.md) |
| 异步部署、观测、故障演练与回滚 | [`docs/async-process-runs-runbook.md`](docs/async-process-runs-runbook.md) |
| 本地开发与改动流程 | [`docs/development.md`](docs/development.md) |
| 从自然语言封装 Business Process | [`docs/authoring-business-processes.md`](docs/authoring-business-processes.md) |
| 查看各 production Business Process | [`docs/processes/README.md`](docs/processes/README.md) |
| 从本地或远程来源集成 Skill | [`docs/integrating-runtime-skills.md`](docs/integrating-runtime-skills.md) |
| 同步 MVP 部署、验收和回滚 | [`docs/mvp-release-runbook.md`](docs/mvp-release-runbook.md) |
| 异步角色部署、验收和回滚 | [`docs/async-process-runs-runbook.md`](docs/async-process-runs-runbook.md) |
| 配置键与示例值 | [`.env.example`](.env.example) 与配置解析测试 |

若文档与代码行为冲突，先按测试确认当前事实，再在同一改动中更新受影响的文档。项目目的、范围或共同语言发生变化时，必须同时更新本文。
