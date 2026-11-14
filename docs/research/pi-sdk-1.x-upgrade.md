# Pi 1.0.0—1.5.2 功能与升级评估

查证日期：2026-11-14。范围为官方已发布的 `v1.0.0` 至 `v1.5.2`，结合本仓库服务端 SDK 接入评估；不把 CLI 功能视为生产能力。本次起点是 `@earendil-works/pi-coding-agent@1.4.0`，目标是准确版本 `1.5.2`，此前迁移记录见 [Pi Runtime 升级评估](pi-runtime-upgrade.md)。验证结果由本次升级记录说明；本文不代表真实网关、模型质量或生产部署验收。

## 优先级判断

最值得采用的是网关兼容配置、Tool 参数校验的适配与已有观测事件。升级后已接入表情包网关 cache key 原生关闭，以及轮次费用金额与来源的归档和控制台展示；分类模型可做独立实验。缓存预热、原生图片生成、codemode 和 MCP 不随依赖升级启用。

| 功能 | 项目判断与接入位置 | 一手依据 |
| --- | --- | --- |
| `compat.promptCacheKeyMode`（1.5.1） | **已接入**。表情包网关在 `model.ts` 固定 `disabled`，让协议 Adapter 从源头不发送 `prompt_cache_key`。它只管 cache key；`prompt_cache_retention`、`prompt_cache_options` 的既有过滤仍需保留。 | [1.5.1 发布](https://github.com/earendil-works/pi/releases/tag/v1.5.1)、[1.5.2 Responses 兼容字段](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/models-configuration.md#openai-responses) |
| 空 Tool 历史与 assistant content 兼容（1.5.1） | **随 SDK 获得协议修复，按实际网关配置例外**。Chat Completions 关掉全部 Tool 后默认省略 `tools`，减少部分网关 400；旧代理需要时才设置 `requiresToolsWithToolHistory`。`requiresNonNullAssistantContent` 可处理只含 Tool 调用的 assistant 必须有空字符串的问题。表情包使用 Responses，不能把 Chat Completions 修复算成其直接收益。 | [1.5.1 发布](https://github.com/earendil-works/pi/releases/tag/v1.5.1)、[兼容字段](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/models-configuration.md#openai-completions) |
| Tool 参数改用 `pi-schema`（1.5.0） | **本次必须适配**。普通 JSON Schema 也参与类型转换；业务校验不能依赖旧 TypeBox 的错误文案或非 JSON Schema 扩展。检查 `composed`、Agent Conversations 与 `search_memes` 的准确参数和拒绝路径；内部 Tool 校验改变不等于公开输入 Schema 改变。 | [1.5.0 破坏性变更](https://github.com/earendil-works/pi/releases/tag/v1.5.0)、[Tool Schema 文档](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/extensions.md#tool-parameter-schemas-and-typebox) |
| `tool_execution_end.durationMs`（1.1.0） | **已经用上**。`src/agent-runtime/trace.ts` 按事件记录 Tool 耗时，无须再维护一套耗时协议。`agent_settled.aborted` 也可用于未来会话结束观测，但当前已有取消路径，不必重复引入。 | [1.1.0 发布](https://github.com/earendil-works/pi/releases/tag/v1.1.0) |
| `Usage.cost.totalFromProvider` 与 OpenRouter 实际总费用修复（1.5.0） | **已接入**。trace 只归档费用金额和来源，控制台区分供应商报告与目录估算。表情包模型的零费率只是注册元数据，未收到供应商费用时不把零估算展示为免费；不归档原始响应，不改变产品计费。 | [1.5.0 发布](https://github.com/earendil-works/pi/releases/tag/v1.5.0) |
| 按 thinking level 配采样参数（1.0.2） | **可实验，已有版本已支持**。适合比较构思与字段修正的稳定性，必须由 Registration 固定且先做样本评估。当前 low/none 已表达推理策略，升级不应顺带改 temperature 等生成行为。 | [1.0.2 发布](https://github.com/earendil-works/pi/releases/tag/v1.0.2)、[模型配置](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/models-configuration.md#models) |
| 文本及图片分类模型（1.0.1、1.1.0、1.4.0、1.5.1） | **适合独立实验**。可研究素材路由或预筛，但需窄 Capability、明确预算及标注集；分类不能代替模板事实核对或人工成图审批。当前 Agent 不获得 codemode，不能直接开放 `models.classify()`。 | [1.1.0 发布](https://github.com/earendil-works/pi/releases/tag/v1.1.0)、[1.4.0 发布](https://github.com/earendil-works/pi/releases/tag/v1.4.0)、[1.5.1 发布](https://github.com/earendil-works/pi/releases/tag/v1.5.1) |

以上“项目判断”来自本次源码检查：共享会话在 `src/agent-runtime/session.ts`，专用模型和请求过滤在 `src/processes/character-emoji/`，受控 Process Tool 在 `src/agent-runtime/process-tools.ts`，业务校验仍由对应 Process 和 Registration 拥有。

## 保持关闭或暂缓

| 上游能力 | 当前决定 | 一手依据 |
| --- | --- | --- |
| 1.5.1 把缓存预热默认值从 `streaming` 改为 `idle` | 共享 Session、模板编译和表情包继续显式 `cacheWarming: "off"`。请求级服务不能因 CLI 默认值新增后台模型请求与费用。 | [1.5.1 发布](https://github.com/earendil-works/pi/releases/tag/v1.5.1) |
| Anthropic message threads（1.5.1）、中途切换 thinking level 保持缓存（1.3.0） | 前者只在实际采用 Anthropic 且网关支持 `thread` 时评估；后者为特定 OpenAI 模型协议优化，不能套用到当前 DeepSeek Responses。当前无需改业务协议或延长会话寿命。 | [1.5.1 发布](https://github.com/earendil-works/pi/releases/tag/v1.5.1)、[1.3.0 发布](https://github.com/earendil-works/pi/releases/tag/v1.3.0) |
| codemode 生图、脚本执行和更省 token 的工具声明（1.0.0 起） | 不进入当前生产 Agent。图片继续由已有受控 Capability 执行，保留审批、幂等、回执和未知提交的恢复规则。上游节省 token 的测量是其内置 Tool 场景，不能当成本项目收益。 | [1.0.0 发布](https://github.com/earendil-works/pi/releases/tag/v1.0.0) |
| MCP、OAuth、工具通配符与动态发现（1.0.0—1.0.4 起） | 不替换服务端准确 Tool allow-list，也不从项目或用户配置自动接入 MCP。只有明确业务需求才设计受限 Adapter。 | [1.0.0 发布](https://github.com/earendil-works/pi/releases/tag/v1.0.0)、[1.0.4 发布](https://github.com/earendil-works/pi/releases/tag/v1.0.4) |
| CLI/TUI、扩展更新提示、登录命令、会话目录迁移 | 供维护者使用，当前无服务端产品收益。1.5.2 主要改进已丢失工作目录的会话 fork 与 Anthropic OAuth 请求信息，不应据此改变生产行为。 | [1.5.0 发布](https://github.com/earendil-works/pi/releases/tag/v1.5.0)、[1.5.2 发布](https://github.com/earendil-works/pi/releases/tag/v1.5.2) |

## 版本覆盖与升级检查

已逐条检查全部十二个发布：`1.0.0`、`1.0.1`、`1.0.2`、`1.0.3`、`1.0.4`、`1.1.0`、`1.2.0`、`1.3.0`、`1.4.0`、`1.5.0`、`1.5.1`、`1.5.2`。其中 `1.0.3` 的 Azure provider 更名已发生在当前基线之前；`1.2.0` 的配置 JSON Schema 适合开发期查阅，生产内存配置不改为加载 `models.json`；`1.3.0` 的内部包准确版本绑定继续通过项目锁文件复现。[1.0.3](https://github.com/earendil-works/pi/releases/tag/v1.0.3)、[1.2.0](https://github.com/earendil-works/pi/releases/tag/v1.2.0)、[1.3.0](https://github.com/earendil-works/pi/releases/tag/v1.3.0)

通用 telemetry 合同、durable response handle 和 v4 Session 持久操作记录已在 `0.84.0` 记录，并非本次范围内新增。它们不能直接替代本项目 PostgreSQL、队列、租约与付费提交恢复合同；本次不据此改造执行架构。[官方 Changelog 的 0.84.0 条目](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/CHANGELOG.md#0840---2026-08-06)

仓库已有修正阶段禁用 Tool、准确 allow-list 和会话隔离测试，本次继续运行这些回归。SDK 的参数转换只用于 Tool 传输，不能替代 Process 的公开输入和业务语义校验。

升级应覆盖四类确定性检查：

1. 无 Tool 会话和准确 allow-list，修正后工具保持关闭；业务输入不能控制模型、Tool 或配置。
2. SettingsManager、凭证与 Session 保持隔离且不落盘，三处缓存预热继续关闭。
3. 新 schema 校验与 Tool 参数转换、取消和调用预算、最终正文提取、净化错误分类保持可验证。
4. `npm run check`、`npm run typecheck`、`npm test`、`npm run build`。真实网关 smoke、付费生成及部署另行明确运行，不能由离线通过推断。

升级及功能接入的四项检查均通过；完整测试为 150 个文件通过、12 个文件跳过，1677 个用例通过、100 个用例跳过。新增回归在真实 Pi Responses Adapter 的出站过滤前核对 cache key，并验证费用来源、零值、无效值与归档回读。未调用真实模型、付费生图或生产部署。

研究建议不自动成为项目契约；现行边界以 [项目级 Agent 与 Skill](../integrating-runtime-skills.md#项目级-agent-与-skill) 为准。
