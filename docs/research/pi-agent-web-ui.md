# Pi Agent 开发 Web UI 调研

## 线上注册目录和执行 trace 应该对照什么

Pi SDK 1.4.0 定义了 Skill 发现机制和遥测 span 接口。在核对的官方接口中未发现跨宿主的业务流程注册协议。Pipipi 用服务端目录注册精确的流程版本，通用 Pi 工具无法据此自动枚举生产流程。[Pi SDK](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sdk.md) · [Pi 遥测](https://github.com/earendil-works/pi/blob/v1.4.0/packages/telemetry/README.md) · [生产目录](../../src/processes/catalog.ts)

用当前依赖的 Pi 加载器扫描本地 `.pi/skills`，识别 23 项，诊断 0 条。Pipipi 用该加载器核对固定 Skill，再关闭会话的自动发现，将本次绑定的正文注入系统提示。当前工作区通过 Pi 的 `skillsOverride` 把已批准项提供给会话资源清单，读取该会话的工具可以列出绑定。正文在创建会话时注入，执行时不需要再读取 Skill 文件。[Skill 加载](../../src/agent-runtime/skills.ts) · [会话创建](../../src/agent-runtime/session.ts) · [Agent Skills 规范](https://agentskills.io/specification)

已安装的官方实验项目 p2 提供 **Settings → Traces** 及 **Show traces** 命令。它从本实例的遥测库读取 span 树、耗时与事件。Langfuse 团队维护了实验性的 Pi 追踪插件，记录模型、工具和用量，默认还采集输入输出和图片。Pipipi 是嵌入式宿主，接入时需要显式配置采集范围并保留现有正文边界。本次未把生产数据发送到 Langfuse。[p2 Traces 源码](https://github.com/earendil-works/pi/blob/275dde410065/apps/p2/plugins/telemetry/web.tsx#L68) · [Langfuse 官方集成](https://langfuse.com/integrations/developer-tools/pi-agent) · [社区嵌入式接入示例](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-langfuse/README.md#-host-application-embedding)

要参考注册目录与执行记录放在同一页面体系的成品，可看 Mastra Studio。它通过 Mastra 服务枚举 Agent、流程和工具，流程图能展示实际执行路径并打开 trace；对现有 Pipipi 服务没有现成连接。[Mastra Studio 演示与文档](https://mastra.ai/docs/studio/overview)

## 开发工作台候选

截至 2026-11-13，想在浏览器里改 Skill、给 Agent 一张样图试跑、看它如何执行，可以先试 **xing-shuyin/pi-web-ui**。它有中文界面、文件编辑器和可执行画布，作者提供了两个动图演示。想直接看 Pipipi 已上线的流程、精确版本和运行记录，入口仍是 Pipipi 运维控制台。本次核对了发布包和源码，运行了 Skill 扫描函数与会话查看器的作者示例。未发起模型请求。[中文演示](https://github.com/xing-shuyin/pi-web-ui/blob/v0.120.0/README.zh-CN.md) · [Pipipi 控制台](../mvp-release-runbook.md)

## Pi 官方的可视化界面

Pi 主仓有可自行启动的 **p2**，可以在浏览器中使用 Pi Durable 会话、查看运行活动、切换模型。官方将它标注为将被替换的实验原型，不提供支持。调研未找到能直接读取 Pipipi 已注册业务流程、展示各版本 Skill 绑定的官方成品。p2 的工作流示例以脚本编排 Agent。[p2 官方说明](https://github.com/earendil-works/pi/blob/main/apps/p2/README.md) · [工作流示例](https://github.com/earendil-works/pi/blob/main/apps/p2/docs/workflows.md)

**Radius** 是 Earendil 提供的在线管理页面。团队可以管理成员、模型、预算、用量和 API Key，也能分享发布到 Radius 的 Pi 会话与产物。[组织管理](https://radius.earendil.com/docs/organizations) · [产物与会话](https://radius.earendil.com/docs/artifacts)

Pi 官方提供 CLI、TypeScript SDK 和 RPC。网上还能搜到的官方 `@earendil-works/pi-web-ui` 是一个历史聊天组件库，npm 上的最后版本为 0.75.3。维护者确认已从 Pi 主仓库移除，当前官方仓库也没有这个子包。下表列的三个项目由社区独立维护。[Pi 官网](https://pi.dev/) · [历史包元数据](https://registry.npmjs.org/@earendil-works%2Fpi-web-ui/0.75.3) · [维护者说明](https://github.com/earendil-works/pi/issues/4966) · [官方包目录](https://github.com/earendil-works/pi/tree/main/packages)

## 三种用途

| 你想做什么 | 值得看的项目 | 实际能操作什么 |
| --- | --- | --- |
| 在一个中文网页里开发 Agent、改 Skill、试跑几个步骤 | **xing-shuyin/pi-web-ui** | 打开项目、编辑包括 `SKILL.md` 在内的文本文件、切换模型、发送图片、查看工具调用；画布可连节点、执行、走审批分支，检查日志和产物。画布保存它自己的图和运行记录。[工作台演示](https://github.com/xing-shuyin/pi-web-ui/blob/v0.120.0/README.zh-CN.md) · [Canvas 执行机制](https://github.com/xing-shuyin/pi-web-ui/blob/v0.120.0/docs/architecture-canvas.md) |
| 从一份需求或 Skill 做出可重复执行的多步原型 | **pi-CAW** | 在 Pi 输入 `/caw` 打开工作台，可从任务描述或 Skill 快照生成草案、检查流程图、配置模型、人工确认后执行，并按节点查运行记录。它导入自己支持的 Workflow 包格式。[作者中文说明](https://github.com/TohmaN233/pi-CAW/blob/main/README.zh-CN.md) · [导入契约](https://github.com/TohmaN233/pi-CAW/blob/main/docs/PORTABLE-WORKFLOWS.md) |
| 浏览多个 Pi 会话、查看 Skill 关系图 | **BlackBelt Pi Agent Dashboard** | Skill Atlas 用卡片、关系图和表格展示 Pi 加载的 Skill；连线来自正文引用、同包或共用工具。配套 pi-flows 开启编辑模式后可由 Agent 写入经校验的流程 YAML 和角色 Markdown，Dashboard 将流程工具的结果画成图。这是另一套文件格式。[Dashboard 演示](https://blackbelttechnology.github.io/pi-agent-dashboard/) · [Skill Atlas 连线规则](https://github.com/BlackBeltTechnology/pi-agent-dashboard/blob/develop/docs/skill-atlas.md) · [流程编辑方式](https://github.com/BlackBeltTechnology/pi-flows/blob/develop/docs/flow-authoring.md) |

版本方面，Pipipi 固定使用 Pi SDK 1.4.0。调研时 pi-web-ui 0.120.0 的 Pi 可选依赖为 `>=1.1.0`，pi-CAW 0.7.0 的 Pi peer 范围为 `>=1.0.0`。BlackBelt Dashboard 0.11.0 声明 `>=1.3.0`，搭配的作用域包 `@blackbelt-technology/pi-flows@0.10.0` 声明 `>=0.84.1 <2.0.0`。这些范围都包含 1.4.0，独立安装时实际解析的版本还取决于各自的依赖环境。三个项目在 2026 年 11 月均有仓库更新。[本项目依赖](../../package.json) · [pi-web-ui 发布包](https://registry.npmjs.org/pi-web-ui/0.120.0) · [pi-CAW 包声明](https://github.com/TohmaN233/pi-CAW/blob/main/package.json) · [Dashboard 发布包](https://registry.npmjs.org/@blackbelt-technology%2Fpi-agent-dashboard/0.11.0) · [pi-flows 发布包](https://registry.npmjs.org/@blackbelt-technology%2Fpi-flows/0.10.0) · [pi-web-ui 更新](https://github.com/xing-shuyin/pi-web-ui/commits/main/) · [pi-CAW 更新](https://github.com/TohmaN233/pi-CAW/commits/main/) · [Dashboard 更新](https://github.com/BlackBeltTechnology/pi-agent-dashboard/commits/develop/)

## 在本地看第一眼

### 免安装查看一次执行

**最快的是打开 Pi 官网引用的公开会话**。页面加载的是作者已经分享的 HTML，可以直接沿会话树阅读消息、展开工具调用和返回值。已核对该链接对应 mitsuhiko 分享的 `session.html`。要看另一种时间线交互，Pi Session Manager 作者提供带样例数据的可点击 Web 演示，可以选择会话查看对话和工具历史。两个入口都可以先看界面，再决定是否运行本地工具。[Pi 官方会话示例](https://pi.dev/session/#0ea51497613daf7e1de28ee99950b074) · [原始分享](https://gist.github.com/mitsuhiko/0ea51497613daf7e1de28ee99950b074) · [Pi Session Manager 交互演示](https://dwsy.github.io/pi-session-manager/demo/) · [作者的演示说明](https://dwsy.github.io/pi-session-manager/en/)

| 想看什么 | 从哪里打开、读什么数据 | 能回答什么 |
| --- | --- | --- |
| 一个已完成的 Pi 会话 | Pi 1.4.0 自带 `/export report.html`，已有会话文件时，嵌入式 SDK 也提供 `session.exportToHtml(path)`。导出文件在浏览器打开；模板和工具渲染逻辑随 coding-agent 发布。|`session` 中实际保存了哪些消息、工具调用、结果与分支。嵌套工具调用可有有界摘要，完整嵌套结果由调用它的工具决定是否报告。独立 HTML 查看这一场会话，多场会话汇总另需数据来源。[会话文档](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sessions.md) · [SDK 方法](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/agent-session.ts) · [HTML 导出实现](https://github.com/earendil-works/pi/tree/v1.4.0/packages/coding-agent/src/core/export-html) · [嵌套工具事件](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/extensions.md) |
| 一次请求带了哪些 Skill、系统指令和上下文 | **hfrancisla/pi-session-viewer** 是本地只读扩展。用 `/session-viewer` 打开，可读磁盘上的 Pi 会话或拖入 JSONL；其项目页提供截图。| 可以沿时间线对齐每轮请求与 Tool 调用、结果，检查此前由扩展捕获的系统指令组成。旧轮次没有捕获记录时标为未记录。Skill 出现在提供给模型的上下文中，只能说明当时可见，不能据此认定模型采用了该 Skill。[中文说明与界面截图](https://github.com/hfrancisla/pi-session-viewer/blob/main/README.zh-CN.md) |
| 多个 Pi 会话、子 Agent 正在做什么 | **BlackBelt Dashboard** 由 Pi 会话中的 bridge 转发事件；配套 `pi-dashboard-subagents` 能在展开子 Agent 卡片后看到正在发生的步骤、工具调用和输出。官网提供录屏。| 有配套事件源时可沿父调用查看子 Agent；其他扩展只报告普通 Tool 事件时按普通工具展示。其 **Skill Atlas** 单独描述可发现的 Skill，通过正文引用、同包或共享工具连线。运行树与 Skill 关系图的数据来源各异。[Dashboard 演示录屏](https://pi-dashboard.dev/) · [发布记录](https://github.com/BlackBeltTechnology/pi-agent-dashboard/blob/develop/CHANGELOG.md) · [Skill Atlas 关系规则](https://github.com/BlackBeltTechnology/pi-agent-dashboard/blob/develop/docs/skill-atlas.md) |

实测 **hfrancisla/pi-session-viewer 0.5.3** 的作者示例时，在中文界面从父会话工具卡点入了名为 `worker-a` 的子 Agent。它说明查看器能够使用存在于样例里的父子关联做下钻；Pipipi 需要提供同等数据才有相同效果。[作者项目与截图](https://github.com/hfrancisla/pi-session-viewer) · [核对的发布包](https://registry.npmjs.org/@hfrancisla%2Fpi-session-viewer/0.5.3)

另一款 **pi-trace-extension 0.1.16** 为每次已接入的会话保存 `events.jsonl` 和独立的 `trace.html`，可展开模型调用、工具和子 Agent。它会记录完整模型请求。已核对源码，只要 `getSessionFile()` 为空，扩展就按子 Agent 处理；缺少 `PI_TRACE_PARENT_DIR` 时直接跳过。因此 Pipipi 的内存会话不能原样交给它充当追踪根节点，默认采集的正文也超出本项目多类流程的记录范围。[作者截图与字段说明](https://github.com/npxcnency-ux/pi-trace-extension/tree/v0.1.16) · [会话判断源码](https://github.com/npxcnency-ux/pi-trace-extension/blob/v0.1.16/extensions/trace/index.ts#L408-L421)

Pipipi 的通用会话创建代码使用 `SessionManager.inMemory` 并关闭自动加载扩展。因此，针对 Pi 磁盘目录的查看器可以读开发者的 CLI 会话；要看某次服务调用里的 Pi 明细，宿主可在会话存活时用 `session.exportToJsonl(path)` 导出当前分支用于获准的开发样本，或只记录获准的事件。Pi 1.4.0 的 `exportToHtml` 会明确拒绝纯内存会话。[HTML 实现](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/export-html/index.ts) · [JSONL 实现](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/session-export.ts)。现有 Process Run Record 能看到已登记的业务步骤。模型输入、系统指令、原图和工具正文的可见范围仍须按该 Process 的记录合同决定。[Pipipi 会话装配](../../src/agent-runtime/session.ts) · [Process 运行记录](../process-runtime-design.md)

### 在开发环境试用画布

可以先看作者的中文演示，再决定是否安装。实际试用需要 Node.js 22.19 或以上。以下命令会从 npm 下载软件并全局安装调研所核对的版本，从一个本地试验项目目录执行即可。启动后默认打开 `http://127.0.0.1:8787`，在设置里选 Pi 引擎使用的模型和凭据。运行真实模型会使用该账号额度。[中文快速开始](https://github.com/xing-shuyin/pi-web-ui/blob/v0.120.0/README.zh-CN.md)

```bash
npm install -g pi-web-ui@0.120.0
pwu .
```

一个有判别力的小实验是，在试验项目中放一份 Skill 副本和一张样图，在工作台编辑一条指令，新开 Pi 会话指定该 Skill 并发送同一张图，比较改动前后的输出。这样验证的是开发体验和那条指令的效果。要验证 Pipipi 的模板成品，则要用对应 Process 版本提交业务输入，经过真实的模型选择、Schema 校验和执行预算。[Pi Skill 调用规则](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/skills.md) · [Pipipi 业务 API](../api.md)

## 对 Pipipi 能省哪一步

当前控制台已有 **业务流程**（`/console/#/processes`）、**Agent 技能**（`/console/#/skills`）、**手动调试**（`/console/#/submit`）。生产流程由 TypeScript 注册，Skill 在装配时绑定。[控制台路由](../../console/routing.ts) · [生产装配](../../src/processes/production.ts)

已用 pi-web-ui 0.120.0 的 Skill 扫描函数在本仓库做只读离线验证，范围限定为项目目录，排除全局、祖先目录和 npm 包。它在 `.pi/skills` 找到 23 项，在 `.agents/skills` 找到 7 项。所以打开本仓库就有现成的 Skill 文件发现能力，生产是否启用、哪个流程版本实际绑定哪份，则由 Pipipi 注册代码决定。[扫描源码](https://github.com/xing-shuyin/pi-web-ui/blob/v0.120.0/server/skill-discovery.ts#L146-L147) · [生产绑定](../../src/processes/production.ts)

上述社区工具认识各自的会话、Skill 文件或画布格式；在核对的接口中，未发现自动导入 Pipipi 注册目录、还原每版绑定并调用原执行入口的适配。因此，要回答“线上有哪些、这个版本绑哪份 Skill、最近一次跑得怎样”，沿用项目自身的目录和运行记录即可。要补齐的可视化信息是每个精确流程版本的直接 Skill，以及它调用的成员流程。[控制台路由](../../console/routing.ts) · [控制台数据展示](../../console/tools.tsx) · [生产流程目录](../../src/processes/catalog.ts) · [生产装配](../../src/processes/production.ts)
