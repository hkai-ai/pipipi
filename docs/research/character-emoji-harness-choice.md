# 表情包 v4 的 Agent 运行时与调试界面选型

2026-11-13。Pipipi 核对到已合并的 `fc5662d`，使用 Pi SDK 1.4.0。本文读取了三条已经执行的本机轨迹。它们经过正常业务入口、真实 Pi SDK 和业务校验，模型、搜索和生图服务使用固定响应。DSH 分别运行了官方 Agent 循环的两轮本机实验和离线视图投影，其他替代框架按官方源码与文档核查。此次没有把整条业务移植到候选框架，也没有调用付费服务。[合并的 PR](https://github.com/hkai-ai/pipipi/pull/43) · [业务入口与测试](https://github.com/hkai-ai/pipipi/blob/fc5662d/test/pi-trace.test.js)

## 同一次调用为什么会有两种结果

一条联网创作请求加载 `character-emoji-planner/v18` 和 `character-emoji-single/v4`。第一轮开放并调用 `search_memes`。搜索服务返回 HTTP 503，业务 Tool 捕获错误并返回「改用原创」的结果，Pi 因此记录这次工具调用已返回。第二轮没有开放工具，方案校验通过，随后单独派发图片。单看模型和工具之间的往返，很容易错过这条成功业务经历过的搜索故障。[本机 503 运行](http://127.0.0.1:54031/console/#/run/dd96ec8b-ffc7-4d18-909c-1b6c8c81f097) · [搜索和兜底的代码](https://github.com/hkai-ai/pipipi/blob/fc5662d/src/processes/character-emoji/agent.pi.ts)

另外两条记录区分了「工具正常返回，搜索材料不足」和「模型提交候选后配字校验失败，原会话修正，通过后才生图」。业务作者控制材料等级、候选 Schema、校验规则、修正次数和图片派发时机。底层会话可以展示提供给它的文本，要按原因汇总和查找这些分支，则需要业务代码给出结构化事实。[材料不足](http://127.0.0.1:54031/console/#/run/f8102e18-d012-46f5-a9b7-cfc4eff1e167) · [配字修正](http://127.0.0.1:54031/console/#/run/faed8b33-0711-4b25-bd78-2195422c0908) · [单图、漫画及生图合同](https://github.com/hkai-ai/pipipi/blob/fc5662d/docs/processes/common/character-emoji/README.md)

**DSH 的实际执行。** 用官方 `@deepseek-ai/dsh-agent-loop@0.2.2-rc.3`、原生工具执行器、内存 SessionStore 和上游测试模型适配器运行一次两轮构思。首轮模型请求获得 `search_memes` 并调用，工具将模拟的 503 转为 `{"status":"original"}`，随后显式注销。第二轮模型请求的工具列表为 `[]`。DSH 生成 18 条原生事件，包含两条 `request/header`、两条 `assistant/message` 和一对 `tool/call` / `tool/result`。结果正文保留了 original，工具状态为 `isError:false`；503 只在模拟工具内部出现。这个实验验证了官方循环与原生事件，范围限于构思步骤。它没有移植生产 Skill、Worker、图片派发，也没有打开 DSH 浏览器验收。可在本机用 Node 24 复跑 `node --experimental-transform-types /tmp/pipipi-dsh-loop-probe/run.mjs`。[官方循环](https://github.com/deepseek-ai/deepseek-harness/tree/39163dd30f703a79079e2d2446545cff3c453738/packages/core/agent-loop) · [本机实验脚本](/tmp/pipipi-dsh-loop-probe/run.mjs) · [18 条原生事件](/tmp/pipipi-dsh-loop-probe/actual-events.json)

DSH 离线对照中，使用上述 503 样本已知的两轮工具清单和工具返回状态，手工构造 DSH 视图输入。直接运行官方 `TrajectorySnapshotBuilder`，得到首轮 `[search_memes]`、次轮 `[]`，工具 Schema 与结果按调用 ID 配对，显示 `isError: false`。HTTP 503、改用原创和业务校验结果没有从这组输入中出现。测试的调用 ID、参数与结果正文都是合成值。这验证了 DSH 已有可复用的会话投影能力；数据经过手工转换，该投影实验没有通过 DSH Web 提交请求。[DSH 视图投影源码](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/client/ui-trajectory/src/client/trajectory-snapshot-builder.ts) · [对应 Pipipi 运行](http://127.0.0.1:54031/console/#/run/dd96ec8b-ffc7-4d18-909c-1b6c8c81f097)

## Pi 与 DSH 分别交付什么

Pi 的 SDK 嵌入同一个 TypeScript 进程，负责模型调用、多轮会话、工具分派和事件。Pipipi 同步 API 和异步 Worker 都可调用相同的 Agent Adapter。DSH 的标准 Web profile 将 Agent、Session 日志、工具注册和浏览器插件装在一个运行时里，前端按 Session 事件展示。官方 TypeScript SDK 的标准路径经 stdio JSON-RPC 驱动 DSH 子进程。用 SDK 启动运行时、启用 Web、让浏览器找到指定会话，是需要分别核对的装配步骤。[Pi SDK](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sdk.md) · [DSH 架构](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/docs/architecture.md) · [DSH TypeScript SDK](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/sdk/client/README.md)

| 想在这条请求上查什么 | Pi 官方能力及当前宿主配置 | DSH 官方 Web，假设请求由 DSH 执行 |
|---|---|---|
| 模型输入、输出、工具调用、返回、耗时、用量 | CLI 可看会话、导出 HTML；SDK 提供会话事件和遥测接口。Pipipi 选择内存会话、关闭扩展自动发现。#43 为控制台接上了采集和页面。另有实验性的 p2，能看自己实例采集的 spans | Trajectory 自带轮次时间线，按请求展开输入输出、工具参数、返回、耗时和可用 token 数据。历史工具保留展示内容；部分原始结构仅在活跃 Session 中可查 |
| 当轮能用哪些工具，实际用了哪个 | SDK 有注册工具与调用事件。Pipipi 会在发送前裁剪工具，#43 在最终载荷读取当轮清单，可区分开放未调用和没有开放 | 有请求记录时可查该步的提示及工具目录，并看到实际调用。对上游网关二次变换后的载荷，仍须在对应 Adapter 核对 |
| 当前系统有哪些流程和 Skill，本次单图或漫画加载哪份 | Pi 提供资源加载器。流程标识、版本和批准绑定在 Pipipi Registration 中，#43 分开显示目录声明与会话实际加载 | 官方可发现 Skill，Web 的斜杠命令可调用 Skill，调用会生成 Instructions 卡。要显示 `character-emoji/v4` 当前批准的精确版本、自动按模式选择以及历史加载快照，需把 Pipipi 目录和选择结果接入 |
| 为什么转原创、为何发起修正、图片是否重复派发 | 业务实现记录搜索结果、规则码和生图活动。#43 把这些事实绑定到对应活动、轮次和工具调用 | 搜索作为 Tool 迁入后可看到返回给模型的内容。要展示被捕获的 HTTP 503、可用性等级、字段修正规则和外部图片派发，要从拥有这些事实的业务模块发事件 |
| 从 API 提交，经队列到 Worker 重试的整条业务 | Pi 管理会话。Pipipi 拥有 `runId`、Attempt、队列、回执与恢复。#43 的独立 API 能读 Worker 产生的 PostgreSQL 轨迹 | DSH 管理自己的 Session、turn 和 step。保留现有队列及业务接口时，需要将 runId/Attempt/活动实例和 DSH Session 对齐，并关联会话外的派发 |

来源：[Pi CLI 与导出](https://github.com/earendil-works/pi/tree/v1.4.0/packages/coding-agent) · [Pi 遥测合同](https://github.com/earendil-works/pi/blob/v1.4.0/packages/telemetry/README.md) · [p2 官方定位](https://github.com/earendil-works/pi/blob/275dde410065/apps/p2/README.md) · [p2 Traces](https://github.com/earendil-works/pi/blob/275dde410065/apps/p2/plugins/telemetry/web.tsx) · [Pipipi 会话组装](https://github.com/hkai-ai/pipipi/blob/fc5662d/src/agent-runtime/session.ts) · [DSH Trajectory](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/client/ui-trajectory/README.md) · [DSH Skill 界面](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/client/ui-skill/README.md) · [跨 Worker 验收](https://github.com/hkai-ai/pipipi/blob/fc5662d/test/pi-trace-async.integration.test.js)

**即使今天安装 DSH Web，已有三条运行仍要在 Pipipi 查。** DSH 的 Trajectory 投影自己的 Session 事件，p2 查询自己实例的遥测存储。Pipipi #43 写入的是按 runId 筛选的 JSONL 或 PostgreSQL 活动记录，过往已丢弃的候选正文也无法由查看器恢复。DSH 能呈现提供方实际给出的内容块，任何查看器都不能补出提供方没有返回的思考正文。[DSH Trajectory 数据来源](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/client/ui-trajectory/README.md) · [Pipipi 的落盘与本机正文规则](https://github.com/hkai-ai/pipipi/blob/fc5662d/docs/mvp-release-runbook.md#运维控制台)

**替换 DSH 的主要工作是重做会话边界。** 可以沿用业务请求 Schema、校验、搜索和生图实现；需要换会话 Adapter，接入获准 Skill 和唯一的搜索 Tool，落实首轮与后续轮次的授权、取消与共享预算，并证明 DSH 的持久化和外发满足现有规则。例如官方 `sdk-minimal` 预设默认带持久 shell、将会话保存为 JSONL，且未装载 Skills/Web；标准 Web 支持 Skill，却有更广的工具面。官方 DeepSeek 请求的 Session-log 贡献插件默认启用，采用时要检查所选 profile、网关、日志留存和上传配置。开发机上适合查看原始参数的轨迹，放到处理受限搜索材料的 Worker 之前必须重新验证。[DSH 最小 SDK profile](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/bundle/sdk-minimal/README.md) · [DSH Web 装配](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/bundle/web-app/README.md) · [Session-log 上传范围和开关](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/session/session-log-deepseek/README.md)

还有一处实际迁移成本在网关协议。Pipipi 的构思使用 OpenAI Responses 兼容的请求形状，会裁剪工具、追加候选 Schema；内层搜索 Adapter 则要求校验原生 Responses 联网调用。DSH 官方 `llm-deepseek` 的 base URL 要提供 Messages 兼容接口，直接替换地址无法证明现有请求语义等价。DSH 也提供基于 `pi-ai` 的多协议 Provider Adapter，可作为受控构思模型接入的候选，内层搜索则可继续复用现有 Adapter。需用固定响应验证每轮的实际工具、Schema 和搜索完成判定；复用模型传输库与使用 Pi 的 AgentSession 是两个独立选择。[DSH DeepSeek Messages](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/llm/llm-deepseek/README.md) · [DSH pi-ai Adapter](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/llm/llm-pi-ai/README.md) · [Pipipi 的内层搜索](https://github.com/hkai-ai/pipipi/blob/fc5662d/src/processes/character-emoji/search.responses.ts)

## 继续使用 Pi 时优先验证的社区组件

2026-11-13 按 GitHub API 的 `stargazers_count` 复核了下列仓库。星数属于相应的完整仓库，多宿主应用、扩展合集和示例的归属已单列。最近 push 为 GitHub 的 UTC 日期，仅表示仓库有更新。

| 项目 | Stars · 最近 push | 对 Pipipi 调试的用途与边界 |
|---|---|---|
| **agegr/pi-web**，Pi 专用 Web | 8,206 · 11-12 | 复用 Pi 本地配置与会话文件，支持会话、Skills、System、Tools、用量。实际用 Chrome 打开了作者的交互演示，能看到 8 条预置会话和 Skill 清单；回复预制，不调用模型。对现有内存会话需宿主提供数据。[交互演示](https://agegr.github.io/pi-web/) · [源码](https://github.com/agegr/pi-web) |
| **ThinkRail**，JetBrains 的 Pi 开发工作台 | 8,223 · 11-13 | Pi 原生会话、项目 workspace、Skill、工具交互和变更审查。适合从作者角度开发 Agent；项目工作区与线上业务目录分别维护。[源码与截图](https://github.com/JetBrains/thinkrail) |
| **PI-Desktop**，Pi 桌面宿主 | 7,960 · 11-13 | 桌面项目与会话管理、Skill、Session Analytics 和可展开的 Worker 会话。这里的 Worker 是该应用内的 Agent 执行会话，跟 Pipipi 的 BullMQ Worker 不同。[源码与截图](https://github.com/vastsa/PI-Desktop) |
| **agentsview**，支持 Pi 的多宿主 Web 查看器 | 6,433 · 11-13 | 本地索引并搜索会话、看工具调用和结果。官方列出 Pi 数据源为 `~/.pi/agent/sessions/`；可测试让它读一份获准的原生格式样本。#43 的 JSONL 是另一种数据结构。[项目](https://github.com/kenn-io/agentsview) |
| **claude-tap**，支持 Pi 的多宿主调试代理 | 3,336 · 11-13 | 本地 Viewer 对比实际经代理的请求、系统提示、Tool Schema、流式响应。适合用可控样本检查第二轮关闭搜索后的真实请求。默认 CLI 接法不会截获别的 API/Worker；原始载荷有正文。[Pi 支持与代理说明](https://github.com/liaohch3/claude-tap) |
| **claude-code-history-viewer**，支持 Pi 的多宿主历史查看器 | 2,315 · 11-10 | 官方列明支持按项目目录读取 Pi JSONL 的消息、已有 thinking 块、Tool 调用和 token 用量。适合历史会话回放。[支持矩阵](https://github.com/jhlee0409/claude-code-history-viewer) |
| **pi-gui / Trace**，Pi 桌面应用的扩展示例 | 1,445 · 11-02 | 订阅 Pi 生命周期，按调用 ID 关联参数与返回，在时间线上显示模型等待、流式输出和工具耗时。只留最近 20 个回复，切换线程即清空。主仓 main 源码提供 Trace 示例，星数属于桌面应用，未验证在 Pipipi 里运行。[Trace 设计与使用](https://github.com/minghinmatthewlam/pi-gui/tree/main/examples/desktop-extensions/trace) |
| **jmfederico/pi-web**，另一款 Pi Web | 941 · 11-12 | 从浏览器监督由其服务器托管的多个 Pi 会话，关闭浏览器后任务继续运行。适合交互工作区。[源码](https://github.com/jmfederico/pi-web) |
| **narumiruna/pi-extensions / pi-langfuse**，Pi 宿主插件 | 778 · 11-13 | 作者专门给出嵌入式接法：进程共享 runtime，每个内存会话创建 controller，支持 host sessionId、`onTraceId` 以及 `captureContent: false`。没有独立 UI，查看端为 Langfuse。星数属于扩展合集。[宿主接入示例](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-langfuse/README.md#-host-application-embedding) |
| **wangmiaozero/pi-harness**，Pi 调试工作台 | 378 · 11-13 | 提供 Runs、Trace、Replay、Evaluation 和 Skill 管理。其 runId 来自自己的 Harness；接入产品 runId 需映射，不能据这两个字段同名推断已互通。[项目](https://github.com/wangmiaozero/pi-harness) |

**BlackBelt Pi Agent Dashboard** 是面向 Pi 会话的 MIT 开源 Web 工作台。2026-11-13 查询 GitHub 为 348 stars。桥接扩展将会话注册到 Dashboard 并转发实时事件。Skill Atlas 展示可发现的 Skill 及其关系；配套的 pi-flows 可以展示用它定义的流程图和执行进度。Pipipi 使用内存会话并关闭扩展自动发现，需在隔离开发实例显式接入桥接层，验证素材、正文及可执行工具的边界。Dashboard 的 sessionId 还需由宿主关联到业务 runId 和 Attempt。已有 Run Record 和精确 Registration 不会自动成为 pi-flows 的流程图。本次核对了源码，尚未在 Pipipi 的表情包运行中验证该桥接。[Dashboard 与演示](https://github.com/BlackBeltTechnology/pi-agent-dashboard) · [会话注册源码](https://github.com/BlackBeltTechnology/pi-agent-dashboard/blob/e78b4c2c0474a8ab04941e76942e5a5b9d92c2d6/packages/extension/src/bridge-handlers/lifecycle.ts) · [Skill Atlas](https://github.com/BlackBeltTechnology/pi-agent-dashboard/blob/e78b4c2c0474a8ab04941e76942e5a5b9d92c2d6/docs/skill-atlas.md) · [pi-flows](https://github.com/BlackBeltTechnology/pi-flows)

对「继续用 Pi，少写开发界面」这一目标，先用 agegr 的免安装演示确认交互需求，再按用途验证 pi-gui 的实时 Trace、宿主侧 pi-langfuse 或 BlackBelt 的桥接，比较各自能看到哪些 Pi 事件，再盘点还需要补的业务字段。只有当需求扩大到替换流程开发框架时，才比较 Mastra Studio。下表列出不同目标对应的方案。

## 按想省下的工作选开源方案

| 想省的工作 | 候选和现成能力 | 接到当前表情包的代价 |
|---|---|---|
| 自己维护通用 trace 瀑布图、跨服务检索 | **保留 Pi，接 OpenTelemetry + Jaeger**。Jaeger 有自托管采集、查询和 Web UI，单容器适合本地试验 | 复用业务已有的脱敏事件生成 spans；API → 队列 → Worker 传播上下文，挂上业务 runId、Attempt 和稳定事件码。生产配置存储和保留期。Pi 的遥测合同可供适配，默认未附后端 exporter。最容易和 #43 并行验证。[Pi Telemetry](https://github.com/earendil-works/pi/blob/v1.4.0/packages/telemetry/README.md) · [Jaeger 入门](https://www.jaegertracing.io/docs/2.23/getting-started/) · [跨进程上下文](https://opentelemetry.io/docs/concepts/context-propagation/) |
| 用现成的 LLM 运行检查和 Skill 追踪页面 | **保留 Pi，自托管 Langfuse**。官方文档有 Pi 集成和可用 Skill 版本、成功读取文件的上报约定。Docker Compose 可作本地检查，无需购买 SaaS；自托管仍需运行服务，部分附加功能需要许可 | Pi 插件是 Langfuse 团队维护的实验发布。Pipipi 关闭扩展自动发现、按批准清单预加载 Skill，应显式投影允许的元数据；不应凭已安装目录声称模型主动用过某份 Skill。跨 Worker、兜底与生图要接宿主事件。启用前用探针核对输入、图像和搜索材料不会持久化。[Pi 集成](https://langfuse.com/integrations/developer-tools/pi-agent) · [Skill 跟踪合同](https://langfuse.com/docs/skill-management/tracing) · [自托管选项](https://langfuse.com/self-hosting) |
| 给流程作者统一的注册目录、运行测试、模型和步骤调试界面 | **Mastra + Studio**。`mastra dev` 提供本地界面，枚举本实例注册的 agents、tools 和 workflows；配置 observability 与 storage 后能查看框架内的模型和流程 span。主体 Apache-2.0，`ee/` 另有许可 | 可先将构思移为一个 agent，把编排与校验注册成 workflow steps，对比不同模式和工具权限。已有 Pipipi Registration、网关变换、图片派发与重复执行保护要适配。若两套目录同时维护，收益会被抵消。[Studio](https://mastra.ai/docs/studio/overview) · [Observability](https://mastra.ai/docs/observability/overview) · [存储](https://mastra.ai/docs/storage) · [许可证边界](https://github.com/mastra-ai/mastra/blob/main/LICENSE.md) |
| 自己维护多 Worker 的长任务恢复、调度历史和重试可视化 | **Temporal + Temporal UI**。Workflow Event History 记录活动调度、开始或结束等事件，支持重放；可把 Pi 构思放入 Activity | 要迁移当前 BullMQ 和部分任务状态管理，再决定哪些业务活动成为 Temporal Activity。模型轮次和 Skill 仍需会话采集。供应商已收到请求却未返回回执时，仍需业务幂等键和查询恢复策略避免重复付费。适合把持久编排列为主要成本时评估。[Temporal Event History](https://docs.temporal.io/encyclopedia/event-history) · [TypeScript 活动历史示例](https://docs.temporal.io/encyclopedia/event-history/event-history-typescript) · [自托管 UI](https://github.com/temporalio/ui) · [Pipipi 图片恢复合同](https://github.com/hkai-ai/pipipi/blob/fc5662d/docs/processes/common/character-emoji/README.md) |

## 给 Pipipi 的判断

**现有生产流程继续用 Pi 有价值，限定在构思和有限工具循环这一层。** 在显式联网的请求中，模型可以实际选择是否调用 Tool，再读取返回继续创作。单图、漫画和无工具海报复用同一套加载器与调用入口；将这些流程接入业务服务时，可以把 shell、文件访问、自动发现和正文落盘关掉。将来的简单单轮结构化调用也可以直接测供应商 SDK 的实现，用实际减少的适配代码和测试面判断是否继续经过 Pi。横向扩展的依据看 Worker、队列和持久状态。更换 Agent SDK 本身不会替代这些角色。[Pi SDK](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sdk.md) · [当前装配](https://github.com/hkai-ai/pipipi/blob/fc5662d/src/app/process-worker.ts) · [共享入口验收](https://github.com/hkai-ai/pipipi/blob/fc5662d/test/pi-trace.test.js)

**Pi 开发工作台先看 agegr/pi-web，实时瀑布图对照 pi-gui 的 Trace，跨会话看板再试 BlackBelt；需要跨服务追踪时评估 Jaeger，准备更换流程框架时再评估 Mastra Studio。** DSH 则适合把「在一个原生会话中开发、观察 Agent」作为主要交互的团队。重做当前全部生产流程，只换来更好的单会话页面，收益有限。检验迁移价值可复用现有固定响应，在另一个 runtime 跑同一个 503 样本和同一个修正样本，并记录可以删除的 #43 展示代码、仍需保留的业务埋点，以及新引入的适配代码。只有正常产品入口、无搜索轮次、次数预算、跨 Worker 恢复、仅派发一次图片和脱敏都能复现时，比较结果才适用于生产替换。[现成的同步验收](https://github.com/hkai-ai/pipipi/blob/fc5662d/test/pi-trace.test.js) · [异步验收](https://github.com/hkai-ai/pipipi/blob/fc5662d/test/pi-trace-async.integration.test.js) · [本机正文明细验收](https://github.com/hkai-ai/pipipi/blob/fc5662d/test/local-trace.test.js)
