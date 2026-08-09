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

生产 catalog 当前注册两个精确版本：

| Business Process | 输入 | 输出 | 实现选择 |
| --- | --- | --- | --- |
| `content-processing/v1` | `{ content: string }` | `{ content: string }` | 服务端可选择 Direct 或 Agent 路径 |
| `titled-content-processing/v1` | `{ title: string, body: string }` | `{ title: string, content: string }` | 复用 Content Processing Capability |

默认 HTTP 入口公开 `GET /healthz`、`GET /readyz` 和 `POST /execute`。每次执行生成独立 `runId`。显式启用并完整配置 Async Process Runs 后，入口还提供 `POST /process-runs` 和 `GET /process-runs/{runId}`；该功能默认关闭，在异步角色组装、故障恢复和生产门禁完成前不得向生产调用方开放。默认同步生产构造不持久化 Run Record；结构化完成日志只保留运行元数据，不保存 Prompt、Tool 过程、模型消息或隐藏推理。

仓库已实现 Async Process Runs Module。它以 `submit/find` 固定公共状态、owner 隔离和 caller-scoped idempotency；PostgreSQL Adapter 以事务持久化 Run、初始 Event 和 Outbox。Outbox Dispatcher 通过统一的 BullMQ `process-runs` Queue 只发布 `{ schemaVersion, runId }`，Worker 再从 PostgreSQL 读取准确 Registration 与 accepted input。真实 PostgreSQL/Redis 集成测试已覆盖两个不同 Process 的成功与业务失败；BullMQ 组件仍未组装进生产 Startup Construction。

图片生成、海报 Skill、对象存储和 Skill A/B 对比目前属于开发实验与集成验证，不属于 `/execute` 的生产 catalog。

## 运行与信任模型

当前默认发布形状是无状态、受控、同步的 Node.js HTTP 服务。实例之间不共享 Agent 会话；每个 Agent 请求创建独立的内存会话。异步开发入口以 PostgreSQL 共享 Process Run，并要求可信网关删除客户端伪造的身份头、注入稳定 caller subject 和网关共享凭证。部署平台负责 TLS、私有入口、调用方认证、实例上限和 Secret 注入。

Agent 只获得 Process Registration 明确授权的窄 Tool。生产内容处理 Agent 只能调用 `process_business_content`，不能使用 Shell、文件读写、代码编辑或任意远程工具。

## 当前不做

项目当前不提供：

- 动态 Process Definition、运行时注册、自动发现、默认版本或版本回退；
- 通用工作流编排、已开放的生产 Queue、跨请求 Agent 记忆或自动重试；
- 应用内用户系统、RBAC、多租户、CORS 或公网匿名调用；
- 生产 Run Record 查询、聊天历史、持久化执行历史或通用幂等；
- 允许 Agent 使用 Coding Tools 的通用 Skill 执行环境。

未来若流程产生发布、扣费、发送等副作用，必须先明确幂等、审计和补偿策略。

异步 Process Run 的持久化提交、owner 查询、HTTP Interface、Outbox 调度和基础 BullMQ Worker 已完成，但功能默认关闭；故障恢复、生产角色组装、重试和 Webhook 仍按开发计划推进。该设计保留现有 Business Process 模型：外部调用方仍只选择准确 Process 和版本；Queue Job、重试与 Worker 配置由服务端拥有。详见 [`docs/async-process-runs-design.md`](docs/async-process-runs-design.md) 和 [`docs/async-process-runs-development-plan.md`](docs/async-process-runs-development-plan.md)。

## Module 模型

项目把复杂行为放在少量稳定 Interface 后面：

| Module | 外部 Interface | 隐藏的 Implementation |
| --- | --- | --- |
| Startup Construction | `constructProcessingService(environment)` | 配置翻译、校验、Adapter 选择和完整生产组装 |
| Processing Application | `listen`、`close` | Node HTTP 生命周期 |
| Process Executor | `execute(request)` | 查找、超时、取消、错误转换和 Run Record |
| Process Registration | `identity`、`accept(input)`、`run(acceptedInput, context)` | Schema、JSON-safe accepted input、Process Definition、依赖、策略和输出验证 |
| Process Attempt Runner | `run({ runId, registration, acceptedInput })` | 预分配 runId、超时、取消和公开错误净化 |
| Async Process Runs | `submit(request, context)`、`find(runId, context)` | 输入接受、owner、幂等摘要和公共状态投影 |
| Process Run Store | 接受 Run、owner 查询、claim、终态转换 | accepted input、attempt、revision 和 fencing；提供内存与 PostgreSQL Adapter |
| Process Work Queue | `enqueue({ schemaVersion, runId })`、`close()` | 去重、容量和调度；提供确定性内存与 BullMQ Adapter |
| Outbox Dispatcher | `dispatchOnce()` | PostgreSQL claim、BullMQ publish、ack 与失败 release |
| Process Worker | `process(job)` | exact Registration 查找、Attempt 执行和受控状态转换 |
| Business Capability | 窄业务方法 | 远程协议、认证、超时和供应商细节 |

Startup Construction 是生产组装 Seam；Process Executor 是同步传输与 Process Runtime 之间的主 Seam；Async Process Runs 是计划中异步 HTTP 与权威 Store 之间的主 Seam；Process Registration 是编写一个 Business Process 版本的 Seam；Process Attempt Runner 让同步入口和异步 Worker 复用同一执行治理。Adapter 只有在 Seam 上存在真实替换需求时才引入。

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
| 本地开发与改动流程 | [`docs/development.md`](docs/development.md) |
| 从自然语言封装 Business Process | [`docs/authoring-business-processes.md`](docs/authoring-business-processes.md) |
| 从本地或远程来源集成 Skill | [`docs/integrating-runtime-skills.md`](docs/integrating-runtime-skills.md) |
| 部署、验收和回滚 | [`docs/mvp-release-runbook.md`](docs/mvp-release-runbook.md) |
| 配置键与示例值 | [`.env.example`](.env.example) 与配置解析测试 |

若文档与代码行为冲突，先按测试确认当前事实，再在同一改动中更新受影响的文档。项目目的、范围或共同语言发生变化时，必须同时更新本文。
