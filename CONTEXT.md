# Business Processing 项目上下文

本文记录项目长期稳定的业务背景、范围和共同语言。它帮助产品、开发者和自动化工具在修改代码前建立同一套理解；安装命令、实现细节和发布步骤分别放在对应专题文档中。

## 项目目的

Business Processing Service 让产品调用方通过一个稳定的 HTTP Interface 执行版本化的业务处理。调用方只需选择明确的 Business Process 版本并提交业务输入，不需要知道流程内部使用本地逻辑、远程 Business Capability，还是受限 Agent。

项目要解决的核心问题是：让实现方式可以演进，同时让产品契约保持明确。服务端集中拥有 Process Definition、输入输出 Schema、获准依赖和运行策略，避免这些知识散落到每个调用方。

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

生产 catalog 当前注册四个精确版本：

| Business Process | 输入 | 输出 | 实现选择 |
| --- | --- | --- | --- |
| `content-processing/v1` | `{ content: string }` | `{ content: string }` | 服务端可选择 Direct 或绑定多个 Runtime Skill 的 Agent 路径 |
| `titled-content-processing/v1` | `{ title: string, body: string }` | `{ title: string, content: string }` | 复用 Content Processing Capability |
| `minimal-zine-poster/v1` | `{ brief: string, text?: string }` | `{ prompt, recipe, interpretation, image }` | 无 Tool Agent 编译固定 Runtime Skill；Poster Rendering Capability 生成并持久化图片 |
| `crt-interface-image/v1` | `{ sourceImageId, palette, aspectRatio }` | `{ aspectRatio, image }` | 无 Tool Agent 编译固定 Runtime Skill；CRT Rendering Capability 解析参考图、编辑、后处理并持久化 PNG |

默认 HTTP 入口公开 `GET /healthz`、`GET /readyz` 和 `POST /execute`。每次执行生成独立 `runId`。显式启用并完整配置 Async Process Runs 后，API 还提供 `POST /process-runs` 和 `GET /process-runs/{runId}`；该功能默认关闭，只有按异步 Runbook 通过容量、恢复、安全、观测和 staged rollout 门禁后才能向外部调用方开放。默认同步生产构造不持久化 Run Record；结构化完成日志只保留运行元数据，不保存 Prompt、Tool 过程、模型消息或隐藏推理。

仓库已实现 Async Process Runs Module。它以 `submit/find` 固定公共状态、owner 隔离和 caller-scoped idempotency；PostgreSQL Adapter 以事务持久化 Run、初始 Event 和 Outbox。Outbox Dispatcher 通过统一的 BullMQ `process-runs` Queue 只发布 `{ schemaVersion, runId }`，Worker 再从 PostgreSQL 读取准确 Registration 与 accepted input。Store 以 claim token 隔离 Attempt；过期租约可被接管，Reconciler 会重投长期 queued 或过期 running Run，停机超时则释放当前 claim。Registration 默认单次执行，也可声明有界错误分类与指数退避；Business Capability 获得稳定 `runId` 幂等键。API、Dispatcher 和 Worker 已有独立 Construction Root、入口、配置与健康检查；真实 PostgreSQL/Redis 集成测试覆盖成功、业务失败、受控重试、Redis 断线、重复 Job、租约接管、有期限停机和 caller 隔离。

`minimal-zine-poster/v1` 已进入 `/execute` catalog。它返回图片 HTTP(S) URL、媒体类型、尺寸和可选过期时间，不把大体积图片字节写入 Process output。调用方不能选择 Skill、模型、图片供应商或存储。OpenAI Images、FAL 与阿里云 OSS 只用于显式真实集成和海报业务验收；Skill A/B 仍是独立实验。

`crt-interface-image/v1` 也已进入 `/execute` catalog。调用方只提交预先上传后得到的不透明 `sourceImageId`、固定调色板名和画幅；请求不接收图片字节、任意 URL、Prompt 或实现配置。Registration 在 Agent 编译结果通过校验后调用一次 CRT Rendering Capability，并只公开画幅和 PNG 引用。仓库已提供支持 OpenAI Images 与 FAL 的 GPT Image 2 reference-edit smoke，以及包含临时上传、`POST /crt-images`、确定性 finalizer、下载与报告的无 OSS 本地业务验收。验收按服务端策略选择不保留证据、只保留脱敏 metadata，或按 `runId` 保留原图、模型原始图、最终图和 manifest；产品请求不能选择该策略。生产受鉴权上传、资产所有权与生命周期、持久化图片服务仍由产品图片平台完成，证据模式必须默认关闭；上游 Runtime Skill 未声明许可证，正式发布前必须确认权利。开发边界见 [`docs/processes/crt-interface-image/`](docs/processes/crt-interface-image/)。

## 运行与信任模型

当前默认发布形状是无状态、受控、同步的 Node.js HTTP 服务。实例之间不共享 Agent 会话；每个 Agent 请求创建独立的内存会话。异步入口以 PostgreSQL 共享 Process Run，并要求可信网关删除客户端伪造的身份头、注入稳定 caller subject 和网关共享凭证。部署平台负责 TLS、私有入口、调用方认证、实例上限和 Secret 注入。

Agent 只获得 Process Registration 明确绑定的 Runtime Skill 集合与窄 Tool。生产内容处理 Agent 同时加载 `content-optimization` 和 `content-integrity`，只能调用 `process_business_content`。海报 Agent 只加载 `minimal-zine-poster-prompt`，没有 Tool；它只返回待校验的 Prompt 计划。CRT Agent 只加载 `tait-crt-interface-prompt`，没有 Tool，也看不到参考图或资产标识；它只返回待校验的 Prompt 与 recipe。各图片 Registration 校验 Agent 结果后，再自行调用一次对应 Rendering Capability。三类 Agent 都不能使用 Shell、文件读写、代码编辑或任意远程工具。Skill 集合随应用发布；调用方不能选择、增加或排序 Skill。

## 当前不做

项目当前不提供：

- 动态 Process Definition、运行时注册、自动发现、默认版本或版本回退；
- 通用工作流编排、已开放的生产 Queue、跨请求 Agent 记忆或调用方控制的重试；
- 应用内用户系统、RBAC、多租户、CORS 或公网匿名调用；
- 同步 Run Record 的生产查询、聊天历史、跨 caller 管理搜索或通用幂等；
- 允许 Agent 使用 Coding Tools 的通用 Skill 执行环境；
- `minimal-zine-poster/v1` 的参考图片输入，以及任一图片流程的自动视觉检查、跨 Run 变化记忆或自动重绘。

`minimal-zine-poster/v1` 与 `crt-interface-image/v1` 会产生模型费用和图片持久化副作用。海报 Registration 不重试 Agent；CRT Registration 可以在任何图片调用前重试一次无副作用的 Agent 编译。两个 Registration 都只调用一次图片 Capability，并把稳定 `runId` 作为下游幂等键；部署方仍须限制调用权限、并发、超时和费用。CRT 流程还处理用户上传资产，必须在产品图片服务中明确所有权、保留、删除和敏感内容策略。新增发布、扣费、发送等副作用前，必须先明确幂等、审计和补偿策略。

异步 Process Run 的持久化提交、owner 查询、HTTP Interface、Outbox 调度、BullMQ Worker、受控 Process 重试和故障恢复已完成。终态事务会为已注册 Endpoint 创建精简 Webhook Delivery；独立 Webhook Worker 使用 Standard Webhooks HMAC 签名，并以 PostgreSQL 管理有界重试、逐次 Attempt 审计、稳定 event ID 和受控人工重放。Endpoint Secret 使用 AES-256-GCM 信封加密；注册和每次投递都重新解析目标、拒绝非公网地址并把连接固定到已检查的 IP，且不跟随重定向。独立 Retention Cleaner 已按 accepted input、公开结果、Run metadata 和 Delivery Attempt 历史的期限分批清理；结果到期不改变终态，metadata 到期删除前还会保护未完成或仍在保留期内的 Delivery 引用。Process Recovery 以 PostgreSQL Run/Outbox 为事实来源，检查 BullMQ 中稳定 `runId` Job 是否仍存在，分批恢复 queued 和租约过期 running Run；全量模式会明确报告仍有活跃租约的 Run，但在租约到期前不抢占。PostgreSQL acceptance 事务还执行 caller/global backlog admission，运维快照和结构化日志覆盖 Run、Outbox、Queue、Worker、Webhook、清理、恢复与存储，API 的 canary/production readiness 固定发布门槛。功能仍默认关闭；启用必须遵循 [`docs/async-process-runs-runbook.md`](docs/async-process-runs-runbook.md)。该设计保留现有 Business Process 模型：外部调用方仍只选择准确 Process 和版本；Queue Job、Endpoint、重试与 Worker 配置由服务端拥有。

## Module 模型

项目把复杂行为放在少量稳定 Interface 后面：

| Module | 外部 Interface | 隐藏的 Implementation |
| --- | --- | --- |
| Startup Construction | `constructProcessingService(environment)` | 配置翻译、校验、Adapter 选择和完整生产组装 |
| Async Role Construction | `constructProcessDispatcherService`、`constructProcessWorkerService`、`constructRetentionCleanerService` | 角色专属配置、依赖和生命周期组装 |
| Processing Application | `listen`、`close` | Node HTTP 生命周期 |
| Process Executor | `execute(request)` | 查找、超时、取消、错误转换和 Run Record |
| Process Registration | `identity`、`retryPolicy`、`accept(input)`、`run(acceptedInput, context)` | Schema、JSON-safe accepted input、Process Definition、依赖、服务端重试策略和输出验证 |
| Process Attempt Runner | `run({ runId, registration, acceptedInput })` | 预分配 runId、超时、取消和公开错误净化 |
| Async Process Runs | `submit(request, context)`、`find(runId, context)` | 输入接受、owner、幂等摘要和公共状态投影 |
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

Startup Construction 是生产组装 Seam；Process Executor 是同步传输与 Process Runtime 之间的主 Seam；Async Process Runs 是异步 HTTP 与权威 Store 之间的主 Seam；Process Registration 是编写一个 Business Process 版本的 Seam；Process Attempt Runner 让同步入口和异步 Worker 复用同一执行治理。Adapter 只有在 Seam 上存在真实替换需求时才引入。

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

设计讨论统一使用 **Module**、**Interface**、**Implementation**、**Seam** 和 **Adapter**。Interface 包含调用方必须知道的全部约束，不只包含 TypeScript 类型。

## 事实来源

| 问题 | 主要来源 |
| --- | --- |
| 项目为何存在、范围和术语 | 本文 |
| 项目是什么、如何完成最短体验 | [`README.md`](README.md) |
| 精确运行行为和公开错误 | `src/` 与 `test/` |
| Module、Interface、invariant 和测试面 | [`docs/process-runtime-design.md`](docs/process-runtime-design.md) |
| 异步提交、查询、Queue 与 Webhook 设计 | [`docs/async-process-runs-design.md`](docs/async-process-runs-design.md) |
| 异步能力的开发顺序与门禁 | [`docs/async-process-runs-development-plan.md`](docs/async-process-runs-development-plan.md) |
| 异步部署、观测、故障演练与回滚 | [`docs/async-process-runs-runbook.md`](docs/async-process-runs-runbook.md) |
| 本地开发与改动流程 | [`docs/development.md`](docs/development.md) |
| 从自然语言封装 Business Process | [`docs/authoring-business-processes.md`](docs/authoring-business-processes.md) |
| 查看各 production Business Process | [`docs/processes/README.md`](docs/processes/README.md) |
| 从本地或远程来源集成 Skill | [`docs/integrating-runtime-skills.md`](docs/integrating-runtime-skills.md) |
| 同步 MVP 部署、验收和回滚 | [`docs/mvp-release-runbook.md`](docs/mvp-release-runbook.md) |
| 异步角色部署、验收和回滚 | [`docs/async-process-runs-runbook.md`](docs/async-process-runs-runbook.md) |
| 配置键与示例值 | [`.env.example`](.env.example) 与配置解析测试 |

若文档与代码行为冲突，先按测试确认当前事实，再在同一改动中更新受影响的文档。项目目的、范围或共同语言发生变化时，必须同时更新本文。
