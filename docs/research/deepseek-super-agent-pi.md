# DeepSeek Super Agent 与 Pi 编排能力调研

检索日期：2026-11-02。

本文面向评估 Agent 编排能力的维护者，区分 Pi 核心、官方扩展示例、独立扩展与本项目实际启用的能力。它记录外部资料与代码核验，不改变生产契约，也不代表已经安装或完成兼容性验收。

## DeepSeek 原型的重点

DeepSeek 在 2026-10-31 提交了 `dsh-superagent-prototype` 的首个公开版本，package 版本为 `0.1.0`。它是 DeepSeek Harness 的 bundle，面向一个 GitHub 仓库，可选接入飞书。官方把它定位为研究参考原型，明确说明不是正式产品，且公开代码没有实现设计文章中的全部设想。[首个提交](https://github.com/deepseek-ai/dsh-superagent-prototype/commit/6337fc823ce20251c8de8085948165c81aaa701e)、[README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/README.md)、[版本](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/package.json)

它把持续协作拆成接收事件、授权接单、任务执行和结果交付：Source 产生 Trigger，程序准入与模型研判决定是否接单，Ticket 保存任务及 Mandate 授权，Assignment 绑定执行会话。已有任务通过 Subscription 接收相关 Thread 的后续消息，不必每条都重新经过主会话判断。每个任务有自己的执行会话和目录；目录可由准备命令创建为 git worktree。[领域合同](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/001-domain.md)、[执行合同](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/003-execution.md)

主动接单有 `off`、`observe`、`auto` 三种模式；默认 `observe` 只记录推断请求是否值得接单，不执行它，但明确请求在三种模式下仍可执行。任务恢复前重新核验授权；订阅到的消息可以补充上下文，不能自行扩大权限。这套规则由宿主执行，是它比普通 subagent Tool 多出来的关键产品行为。[授权合同](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/002-authorization.md)

原型用 SQLite 保存任务与消息状态，外部动作通过持久效果队列与 Outbox 执行，并处理重启恢复、输入投递失败和人工介入。这里能确认的是持久状态与恢复机制；不能据此把设计文章中的独立语义 Watchdog 或云端计算与端侧执行分离都算成原型现成功能。Worker 以操作者系统权限运行，独立目录也不等于隔离沙箱。[实现架构](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/007-architecture.md)、[执行及恢复边界](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/003-execution.md)

## Pi 的结论

Pi 已有持久 Agent Harness、多 Agent 委派、并行任务和聊天事件接入的实现。需要分别看官方 `pi-durable` 运行库、Pi coding-agent 扩展和完整产品控制面。coding-agent 的官方 README 把 sub-agents 和 plan mode 留给扩展或 package；这不表示整个 Pi monorepo 都缺少子任务运行原语。[官方包列表](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/README.md)、[coding-agent README](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/coding-agent/README.md)

原 `badlogic/pi-mono` 地址已转向 `earendil-works/pi`。本次官方主分支的 coding-agent 版本与本项目依赖均为 `1.4.0`；版本相同只说明核心对齐，不能证明任一第三方扩展已通过本项目验证。[官方 package.json](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/coding-agent/package.json)、[本项目依赖](../../package.json)

## 持久运行与事件入口

`@earendil-works/pi-durable` 是最值得对照的官方底座。`v1.4.0` 已提供原子保存的 Conversation、模型轮次、Tool、Document 和 Task；重启后恢复任务；`requestId` 去重；`sleepUntil` 持久定时唤醒；子任务所有权、取消传播、等待策略和 Task Graph。SQLite、JSONL、IndexedDB 与 Cloudflare Durable Object 都有 Storage Adapter。它仍标为 Experimental，API 可能在版本间不经预告变化，而且一份 Storage 由一个进程拥有，没有跨进程锁。[v1.4.0 文档](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/README.md)

`v1.4.0` 还包含完整的后台子 Agent 示例 `23-subagent-background.ts`：spawn、message（steer/follow-up）、wait、stop、list；后台 anchor task 管理子会话，reporter task 将结果送回父会话，requestId 防止重启后重复发送。它属于可复用的官方示例，需要宿主装配，不能等同于 coding-agent CLI 默认启用的 Tool。[v1.4.0 后台子 Agent 示例](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/test/examples/23-subagent-background.ts)、[所有权与取消语义](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/README.md#abort-and-subagents)

`earendil-works/pi-chat` 提供外部聊天入口：当前自身 README 明确列出 Discord、Telegram，每个频道连接独立 Gondolin 微型 VM，保留 workspace、memory 和 skills，并用 tmux 管理多个频道 Worker。虽然 Pi 根 README 把链接概括为 Slack/chat automation，不能据此断言当前 pi-chat 已支持 Slack。其 package 仍声明旧 `@mariozechner` peer dependencies；接入当前 Pi 1.4.0 需要单独验证。[pi-chat README](https://github.com/earendil-works/pi-chat/blob/9adbd29b40ee27ff1decf0fc87cbe180b40924f5/README.md)、[package.json](https://github.com/earendil-works/pi-chat/blob/9adbd29b40ee27ff1decf0fc87cbe180b40924f5/package.json)

工程判断：`pi-durable` 覆盖持久执行原语，`pi-chat` 覆盖部分外部事件入口；两者不自动组成带业务策略、长期委托、工单及人工控制台的完整产品。

## 多 Agent 委派实现

| 实现 | 已有能力 | 适用范围与边界 |
| --- | --- | --- |
| Pi 官方 `examples/extensions/subagent` | 独立 Pi 子进程；single、parallel、chain；角色独立 Prompt、Tool 和模型；流式进度、用量、取消传播；并行一次至多 8 个任务、4 个同时执行 | 官方示例，需主动加载；不是核心内置。适合学习最小委派结构。 |
| `badlogic/pi-subagent` | 每个子 Agent 独立 tmux 与持久 JSONL Session；`spawn/status/send/wait/stop/list`；中途引导、后续任务、直接进入子 TUI | Pi 作者账号下的独立项目，依赖 tmux；禁止嵌套子 Agent。父 Session 关闭时子任务暂停并保留历史，恢复父 Session 后以空闲状态重建。 |
| `nicobailon/pi-subagents` | 前台进程内 SDK Session、后台独立 runner；预置 scout、worker、reviewer、oracle 等；并行审查、review loop、council、FleetView；可选择 fresh/fork context 与 worktree | 社区扩展。当前 README 要求 Pi ≥1.2.0；本次源码 package 版本为 `0.84.0`，不能把主分支版本直接当成已发布 npm 版本。 |
| `nicobailon/pi-messenger` | 多 Session 通信、任务认领、文件预约；Crew 规划、分批并行执行、审查；可选 Team 角色、持久记忆与审批门禁 | 社区协作扩展，更接近共享工程团队。它使用自己的 Crew Agent，不依赖或调用 pi-subagents 的执行扩展。 |

来源：[官方 subagent 示例](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/coding-agent/examples/extensions/subagent/README.md)、[作者独立 subagent](https://github.com/badlogic/pi-subagent/blob/4fc1fe5178d1a2b474794a5ee39e7295844e9d3c/README.md)、[社区 pi-subagents](https://github.com/nicobailon/pi-subagents/blob/e9a31b3ea776587d18252616e292277db08a535c/README.md)、[其 package.json](https://github.com/nicobailon/pi-subagents/blob/e9a31b3ea776587d18252616e292277db08a535c/package.json)、[pi-messenger](https://github.com/nicobailon/pi-messenger/blob/a704e7202fa5a7d9fa4b95e8c87cf46950bc3444/README.md)。

`pi-subagents` 已提供可编程编排：用 `runs.run` 串行委派、`runs.all` 并行分发、`runs.lanes` 表达多条有序任务线，并支持条件分支、结果引用与中断后的部分结果复用。当前主分支默认使用脚本形式；旧的顶层 `chain/tasks/parallel` 接口不能当成现行默认 API。该项目称脚本执行环境为权限层，明确不等同于 OS 沙箱。[编排文档](https://github.com/nicobailon/pi-subagents/blob/e9a31b3ea776587d18252616e292277db08a535c/docs/workflows.md)、[Tool 参考](https://github.com/nicobailon/pi-subagents/blob/e9a31b3ea776587d18252616e292277db08a535c/docs/tool-reference.md)

以上能力证明 Pi 生态已有编排工具，并不证明它与另一套 harness 的效果、故障恢复语义或性能相同。本次未运行模型对照实验，也未安装这些扩展。

## SDK 层可以复用的原语

Pi SDK 的 `createAgentSession` 提供独立会话，可指定模型、Tool、资源加载器、持久或内存 Session。`steer`、`followUp`、`abort`、事件订阅和 Session 分支可以作为调度器的基础。宿主仍须拥有任务依赖、汇总、并发上限、成本预算与生命周期；单个 Session API 不等于完整多 Agent 调度器。[SDK 文档](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/coding-agent/docs/sdk.md)

Tool 可以由 extension 注册，也可以在 SDK 初始化时通过 `customTools` 显式注入。采用后者可以沿用服务端固定 allow-list，而无需开启全局或项目 extension 发现。[Extension API](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/coding-agent/docs/extensions.md)、[SDK 文档](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/coding-agent/docs/sdk.md)

## 能力对应与选择

下表是基于上述实现的工程判断，不是效果基准测试。

| 需要的能力 | Pi 对应实现 | 尚需宿主承担的部分 |
| --- | --- | --- |
| 多个独立任务持续执行、追加消息 | `pi-durable` 后台子 Agent 示例；`pi-subagent` | 全局 Router、任务归属和跨渠道关联 |
| 重启恢复、定时唤醒、任务状态 | `pi-durable` | 业务副作用幂等、部署常驻和资源治理 |
| 从聊天渠道接收事件 | `pi-chat` | GitHub/飞书 Source、跨入口同一任务识别 |
| 主动发现值得处理的事情 | 可用自定义 Tool、Hook 与持久任务实现 | Policy、程序准入、模型研判、授权范围与撤销 |
| 人工介入和结果交付 | Task Graph、扩展状态界面可提供基础 | 面向业务的待办面板、审批和渠道回复策略 |

若目标是给个人 Pi 增加多任务委派，先评估作者的 `pi-subagent`；若目标是自己开发持续在线的服务，优先研究 `pi-durable` 的发布版和后台子 Agent 示例；若目标是直接复现 GitHub/飞书接单产品，DeepSeek 原型更接近完整参考应用。本次核验范围内，Pi 的这些组件没有直接组成与 DeepSeek 原型等价的一键产品。已有 Pi 项目无需仅因需要多 Agent 就更换 Harness。

## 本项目的实际状态

本项目已经用 Pi 组织业务 Tool，但没有启用通用子 Agent 扩展。`PiSessionSupport` 每次创建独立内存 Session，关闭 extension、自动 Skill、Prompt template、主题和上下文文件发现；固定 Runtime Skill 由本项目校验后注入。安装一个个人 Pi package 不会自动进入此服务端路径。[Session Implementation](../../src/agent-runtime/session.ts)

当前最接近编排的入口有两个：

- `composed-task/v1`：Planner 在固定 allow-list 中调用 Business Process，服务端控制步数、付费步数、期限和结果来源；步骤强制串行，默认关闭。它是受控 Process 组合，不是任意子 Agent 网络。[专题](../processes/common/composed-task/README.md)、[步骤串行实现](../../src/processes/composed/tools.ts)、[Pi Tool](../../src/processes/composed/agent.pi.ts)
- Agent Conversations：请求级 Pi Session 获得 Registration 固定的 Process Tools，Tool 设置 `executionMode: "sequential"`；跨 Turn 的公共上下文和执行可靠性由本项目 Store、Worker 与账本负责。它没有向模型开放 `spawn_agent`、Shell 或任意编排脚本。[Pi Interactive Agent](../../src/agent-conversations/agent.pi.ts)、[设计](../agent-conversations-design.md)

若后续需要服务端多 Agent 能力，可先在已有 Module 内增加少量固定角色和窄委派 Tool，沿用精确 Registration、请求内 Session、共享截止时间、取消传播、预算与净化结果。这个方向是基于现有边界的工程建议，尚未实现。生产请求继续只提交业务输入，不能选择模型、子 Agent 定义、Skill、脚本或 Tool。

## 核验范围

本次读取了官方及维护者源码文档、本项目依赖和关键 Implementation，并通过 `git ls-remote` 固定上述仓库 HEAD。GitHub REST API 遇到未认证限流，因此没有以其结果证明发布时间；本报告不把 HEAD 获取时间当成发布日期。只新增调研文档，没有修改 Runtime、安装依赖或进行模型调用。
