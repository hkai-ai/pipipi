# Pi coding agent 扩展生态调研

检索日期：2026-08-09

本文面向考虑为本项目增加 Pi 能力的维护者。它只调查 Pi coding agent 的 **extension**，不把 theme、Skill 或 prompt template 当成插件；同时区分个人交互式 Pi CLI、Codex Development Skill 与本项目生产 Runtime Skill。

## 结论

这里的“pi-agent”最可能指原 `badlogic/pi-mono` 中的 Pi coding agent。原仓库地址现已重定向到 [`earendil-works/pi`](https://github.com/earendil-works/pi)，官方 README 明确区分交互式 `@earendil-works/pi-coding-agent` 与底层 `@earendil-works/pi-agent-core`。本项目依赖的也是 [`@earendil-works/pi-coding-agent`](../../package.json)，因此后文使用它的 extension/package 生态作为调查对象。

当前不应把任何社区 extension 直接加入生产 Agent。[`PiContentAgent`](../../src/processes/content/pi.ts) 和 [`PiPosterAgent`](../../src/processes/poster/pi.ts) 都显式设置 `noExtensions`、`noPromptTemplates`、`noThemes` 和 `noContextFiles`，并为每个请求创建独立内存 Session。前者只暴露 `process_business_content`，后者没有 Tool。这与 [`CONTEXT.md`](../../CONTEXT.md) 中“请求级无状态、无跨请求记忆、无通用 Coding Tools”的信任模型一致。

如果维护者另行使用交互式 Pi CLI 开发本仓库，建议先试用一个低外部副作用的 extension：`@juicesharp/rpiv-ask-user-question`。MCP、LSP、人工计划审阅和权限提示都有价值，但只应按明确需求安装到个人开发环境。Subagent、Web、浏览器、记忆、遥测和自动安全审计 extension 当前都不适合进入本项目生产 Runtime。

## Pi 的 extension 与 package 机制

Pi extension 是随宿主进程运行的 TypeScript 模块，可以注册模型可调用 Tool、拦截事件和 Tool call、修改 context/compaction、增加命令、保存 Session 状态和创建 TUI。全局 extension 位于 `~/.pi/agent/extensions/`，项目 extension 位于 `.pi/extensions/`；项目资源只有在 project trust 后加载。官方同时明确说明：extension 与 Pi 进程拥有相同的系统权限，可以执行任意代码。[Pi extension 文档](https://pi.dev/docs/latest/extensions)

“Pi package”是分发容器，不等于 extension。一个 package 可以同时声明 `pi.extensions`、`pi.skills`、`pi.prompts` 和 `pi.themes`；没有 manifest 时也会按约定目录发现这些不同资源。本调研只收录 manifest 中确实声明 `extensions` 的包。[Pi package 文档](https://pi.dev/docs/latest/packages)

Pi 支持 npm、Git 和本地路径来源。固定 npm 版本或 Git ref 会跳过普通更新；`pi -e` 可以只在一次运行中试用。项目级 `pi install -l` 会写入 `.pi/settings.json`，受信项目启动时还会自动安装缺失 package，因此不应在未完成供应链审查前把第三方 package 写入仓库设置。[安装、固定与项目自动安装规则](https://pi.dev/docs/latest/packages#install-and-manage)

本仓库当前没有 `.pi/settings.json` 或 `.pi/extensions/`。本节描述的是可供个人 Pi CLI 评估的项目级扩展机制，不是仓库当前配置；生产 Agent 与 Runtime Skill 的实际分层见 [`integrating-runtime-skills.md`](../integrating-runtime-skills.md#项目级-agent-与-skill)。

官方文档说明，npm package 只要带 `pi-package` keyword 就会进入 gallery；每个详情页仍警告第三方 package 可执行代码并要求安装前审查。由这两条一手规则可以判断：gallery 是发现入口，不应视为经过人工安全审核的 marketplace；“在官方 gallery 中”也不代表官方背书或安全认证。[Gallery 发现规则](https://pi.dev/docs/latest/packages#gallery-metadata)

## “知名”的可验证口径

本报告以四个信号筛选代表项：

1. package 在官方 gallery 中被识别为 extension；
2. 2026-08-09 gallery 显示的月下载量；
3. GitHub stars/forks、仓库是否归档以及最近 push；
4. 最新 npm 版本、发布时间、许可证和对当前 Pi `0.84.1` 的 peer dependency 声明。

下载量不是安装用户数，也不是信任信号；CI、镜像、依赖安装和异常流量都能放大它。GitHub stars 同样只是社区关注度。下面把两者与维护和兼容信号交叉使用，不按单一数字排序。尤其 `@vigolium/piolium` 的详情页同时显示 `479.6K/mo` 和仅 `1,316/wk`，且它声明的 Pi peer range 不包含当前版本，是不能按下载量直接安装的反例。

## 代表性 extension

<!-- markdownlint-disable MD013 -->

| Extension | 用途与知名度信号 | 权限、数据与兼容面 | 对本项目的判断 |
| --- | --- | --- | --- |
| [`@juicesharp/rpiv-ask-user-question`](https://pi.dev/packages/%40juicesharp/rpiv-ask-user-question) | 结构化多问题选择器；gallery `49.8K/mo`，`2.4.0` 发布于 `2026-08-03`；其 monorepo 在 `2026-08-09` 有约 580 stars。[仓库/API](https://api.github.com/repos/juicesharp/rpiv-mono) | 注册一个交互 Tool。维护者声明它不单独调用模型、不需要 API key、无 native dependency，非交互模式会移除该 Tool；仍需把整个 npm package 当作可执行代码审查。[npm metadata](https://registry.npmjs.org/%40juicesharp%2Frpiv-ask-user-question/latest) | **建议加入个人 Pi CLI**。它能减少 Agent 对公开契约和副作用的猜测；不进入服务端 Runtime。 |
| [`pi-mcp-adapter`](https://pi.dev/packages/pi-mcp-adapter) | 按需发现 MCP Tool，避免把全部 Tool schema 放进 context；gallery `290K/mo`，仓库约 1.2k stars，并在 `2026-08-09` 有 push。[仓库/API](https://api.github.com/repos/nicobailon/pi-mcp-adapter) | 可以启动配置的本地命令、连接远端 server、调用 MCP Tool 和管理 OAuth；配置还支持用可信命令解析 Secret。虽有 lazy connection、OS credential store 和逐 Tool approval，实际权限仍由所连 server 决定。[配置与安全面](https://pi.dev/packages/pi-mcp-adapter#server-options) 最新版 peer `@earendil-works/pi-ai ^0.84.1`，与本项目 minor 对齐。[npm metadata](https://registry.npmjs.org/pi-mcp-adapter/latest) | **按需加入个人 Pi CLI**。只有出现一个明确、经过 allowlist 的 MCP server 时再装；生产应把所需动作收敛为窄 Business Capability，而非通用 MCP。 |
| [`pi-lens`](https://pi.dev/packages/pi-lens) | LSP、linter、formatter、type checker、AST/结构化搜索与代码影响诊断；gallery `41.6K/mo`，仓库约 315 stars，并在 `2026-08-09` 有 push。[仓库/API](https://api.github.com/repos/apmantza/pi-lens) | 会扫描代码、启动语言工具，并可能格式化/修复文件。官方详情页提醒 npm/git 安装可能执行需批准的 lifecycle/prepare scripts。最新版还直接依赖 `@earendil-works/pi-tui ^0.82.1`，与宿主 `0.84.1` 不同 minor，必须做加载、TUI 和写入 smoke。[npm metadata](https://registry.npmjs.org/pi-lens/latest) | **按需加入个人 Pi CLI**。若主要用 Pi 写 TypeScript，它有开发价值；仓库已有 typecheck/test/build，因此不是生产依赖。 |
| [`@plannotator/pi-extension`](https://pi.dev/packages/%40plannotator/pi-extension) | 在本地浏览器审阅、批注并批准计划或 diff；gallery `37.1K/mo`，`0.26.4` 发布于 `2026-08-07`；跨 Agent 仓库约 560 forks、958 commits。[源码仓库](https://github.com/backnotprop/plannotator) | package 约 38.7 MB，会启动本地 review UI、读取计划/diff；URL annotation、远端 PR、Ask AI 和 sharing 会按功能访问网络。项目说明默认本地保存，但 UI 会检查 GitHub release，且 plan mode 的 Bash 不是安全边界。[Pi extension 行为](https://pi.dev/packages/%40plannotator/pi-extension) | **按需加入个人 Pi CLI**。适合频繁人工审阅计划或 diff；试用时禁用 AI/share/URL fetch，并不把“计划模式”当权限隔离。 |
| [`@gotgenes/pi-permission-system`](https://pi.dev/packages/%40gotgenes/pi-permission-system) | 对 Tool、Bash、MCP、Skill 和敏感路径执行 allow/ask/deny；gallery `31K/mo`，仓库约 142 stars，最新版 `24.0.0` 支持 Pi `>=0.79.0`。[仓库/API](https://api.github.com/repos/gotgenes/pi-packages) [npm metadata](https://registry.npmjs.org/%40gotgenes%2Fpi-permission-system/latest) | 它本身拥有完整进程权限，只是 in-process gate。Pi 官方明确说 project trust 和 extension gate 不是 sandbox；真实隔离必须由容器、VM 或策略 sandbox 提供。[Pi 安全模型](https://pi.dev/docs/latest/security) | **按需加入个人 Pi CLI**，作为误操作提示层；不能替代本项目现有 Tool allowlist、容器和服务端 Registration。 |
| [`@braintrust/pi-extension`](https://pi.dev/packages/%40braintrust/pi-extension) | 由 Braintrust 组织维护，跟踪 Session、turn、LLM、Tool、compaction 和 branch summary；gallery `17.7K/mo`，`0.10.0` 发布于 `2026-07-17`。[源码仓库](https://github.com/braintrustdata/braintrust-pi-extension) | 需要 API key，并后台向 Braintrust 发送 trace。维护者说明 provider payload 只记录 allowlist metadata，不记录完整 payload/thinking signature；但启用前仍需逐字段确认 Tool span、业务内容、保留期、caller 隔离和故障行为。[配置与 trace 字段](https://pi.dev/packages/%40braintrust/pi-extension) | **暂缓**。本项目当前明确不记录 Prompt、Tool 过程或模型消息；若以后需要 Agent observability，应先定义独立遥测 Interface 和数据治理，再评估 SDK，而不是直接开 CLI extension。 |
| [`pi-subagents`](https://pi.dev/packages/pi-subagents) | 子 Pi Session、前后台 delegation、并行 review 和持久任务；gallery `210.9K/mo`，仓库约 3.0k stars、475 forks，`0.45.0` 发布于 `2026-08-09`。[源码仓库](https://github.com/nicobailon/pi-subagents) | 会启动 child Pi、增加模型成本和并发，并允许不同 agent 获得文件写入、Shell、MCP、Skill 或其他 extension；最新版声明 Pi AI `>=0.80.0`，表面兼容当前版本。[npm metadata](https://registry.npmjs.org/pi-subagents/latest) | **暂缓**。当前开发宿主已经提供 subagent 能力；生产 Runtime 则需要受控 Process Attempt、并发、审计和幂等，不能用 coding-agent 子进程替代。不要与 `@tintinweb/pi-subagents`、`@gotgenes/pi-subagents` 混装。 |
| [`pi-web-access`](https://pi.dev/packages/pi-web-access) | Web search/fetch、PDF、YouTube/本地视频和 GitHub clone；gallery `211.5K/mo`，仓库约 1.0k stars，并在 `2026-08-08` 有 push。[仓库/API](https://api.github.com/repos/nicobailon/pi-web-access) | 会向多个 search/extraction provider 发送 query、URL 或页面内容，可读取 API key、clone repo，并可调用 `ffmpeg`/`yt-dlp`。部分 hosted fallback 需 opt-in，但 zero-config 路径仍访问外部服务。[Provider 与 Secret 配置](https://pi.dev/packages/pi-web-access) | **暂缓**。当前开发宿主已有受控 Web 工具；生产 Business Process 没有任意网络检索需求。未来应为准确 host 和响应 schema 建 Business Capability Adapter。 |
| [`@remnic/plugin-pi`](https://pi.dev/packages/%40remnic/plugin-pi) | 跨 Session recall、消息观察、compaction archive 与 MCP memory；gallery `40.4K/mo`，`9.49.0` 发布于 `2026-08-04`，上游仓库维护活跃。[源码仓库](https://github.com/joshuaswarren/remnic) | 会观察 user/assistant/tool messages，连接带 auth token 的 Remnic daemon，并按配置注入最多约 12K 字符 recall；还可注册 MCP Tool。[Pi connector 行为](https://pi.dev/packages/%40remnic/plugin-pi) | **暂缓**。它直接冲突于请求级 Session 隔离、无跨 caller 记忆和不保存模型消息的产品约束。 |
| [`pi-memory`](https://pi.dev/packages/pi-memory) | 较轻的本地 Markdown 记忆、daily log、scratchpad 和可选 qmd 搜索；gallery `18.2K/mo`，`0.4.1` 发布于 `2026-08-09`。[源码仓库](https://github.com/jayzeng/pi-memory) | 写入 `~/.pi/agent/memory/`，每个 turn 可注入最高 16K 字符；可自动运行 qmd 并下载 embedding model。[实现说明](https://pi.dev/packages/pi-memory) | **暂缓**。即使数据留在本地，它仍制造跨 Session 状态和业务内容持久化；不适合当前服务端信任模型。 |
| [`@vigolium/piolium`](https://pi.dev/packages/%40vigolium/piolium) | 17 阶段仓库安全审计、subagent、PoC 与报告；gallery 显示 `479.6K/mo`，但同页仅 `1,316/wk`，版本仍为 `0.0.13`；仓库约 108 stars。[仓库/API](https://api.github.com/repos/vigolium/piolium) | 深度审计可运行数小时，使用文件系统、Shell、子 Agent，并写大量审计与 PoC 产物。其 npm metadata 对当前 Pi 核心包声明 `^0.74.0` peer；按 semver 该范围不包含本项目 `0.84.1`。[npm metadata](https://registry.npmjs.org/%40vigolium%2Fpiolium/latest) | **暂缓**。下载数字是异常而非成熟度证明，且没有声明兼容当前宿主。安全审计应在隔离环境中按单次 Development Tool 评估。 |
| [`mitsupi`](https://www.npmjs.com/package/mitsupi) | Armin Ronacher 的 commands、Skills、extensions 和 themes 合集；约 `7.8K/mo`，源码仓库约 2.8k stars，社区关注度高。[源码仓库/API](https://api.github.com/repos/mitsuhiko/agent-stuff) | 它是混合 package，不应整包默认加载。最新 `1.6.0` 仍把旧的 `@mariozechner/pi-*` 包声明为 peer，npm metadata 也没有许可证字段；当前宿主已改用 `@earendil-works/pi-*`。[npm metadata](https://registry.npmjs.org/mitsupi/latest) | **暂缓**。可借鉴单个 extension 的设计，但在维护者发布新 namespace 兼容版本并逐项审查前不要安装整包。 |

<!-- markdownlint-enable MD013 -->

## 三档建议

### 建议加入

生产 Runtime：**无**。

个人交互式 Pi CLI：可以先固定版本试用 `@juicesharp/rpiv-ask-user-question@2.4.0`。它直接改善高影响决策的澄清质量，外部副作用最小，也不会改变本项目生产构造。

### 按需加入

- 有准确 MCP server 和 Tool allowlist 时：`pi-mcp-adapter`。
- 主要用 Pi 进行代码修改，且愿意验证 lifecycle script、formatter 和 Pi minor 兼容时：`pi-lens`。
- 频繁需要人在执行前审阅计划或 diff 时：`@plannotator/pi-extension`。
- 需要交互式误操作提示时：`@gotgenes/pi-permission-system`，同时保留 OS/container 隔离。

这些 package 都只建议安装到个人 Pi 环境。不要把它们提交到 `.pi/settings.json`，除非团队已经审查准确 tarball、许可证、脚本、依赖、网络和 Secret 面，并接受受信项目会自动安装 package 的行为。

### 暂缓

`pi-subagents`、`pi-web-access`、`@remnic/plugin-pi`、`pi-memory`、`@braintrust/pi-extension`、`@vigolium/piolium` 和 `mitsupi` 当前都与已有能力重复、与生产信任模型冲突，或存在兼容/遥测/供应链问题。浏览器自动化类 extension 也同样暂缓；它们可以操作已登录页面、cookie、下载和外部写入，只有出现明确 Business Process 与受控 Adapter 设计后才值得重新评估。

## 安装前的最小验证

以下命令会联网下载并执行第三方 package，只应在审查源码和 npm tarball 后、在个人或隔离环境执行：

```bash
pi -e npm:@juicesharp/rpiv-ask-user-question@2.4.0
```

一次性试用通过后，也应固定 npm 版本，而不是跟随 `latest`。验证至少包括：extension 能在 Pi `0.84.1` 加载；没有意外新增 Tool；没有读取本项目 Secret；没有未声明网络或子进程；退出后没有残留 daemon；`npm diff` 与源码 tag 对应；许可证和回滚版本明确。

Pi 官方建议对不受信或无人监督的工作使用容器、VM、micro-VM 或策略 sandbox，并只挂载必需文件、提供最少凭证、按需限制网络。[Pi 安全与隔离建议](https://pi.dev/docs/latest/security#running-untrusted-or-unmonitored-work)、[容器化模式](https://pi.dev/docs/latest/containerization)

## 与本项目 Skill 边界的关系

Pi extension、Development Skill 和 Runtime Skill 不能互换：

- extension 是在 coding-agent 进程内执行的 TypeScript，默认继承该进程的全部权限；
- `.agents/skills/` 中的 Development Skill 指导 Codex 开发仓库；
- `.pi/skills/` 中的 Runtime Skill 只为服务端受限 Agent 提供任务说明，不会授予权限；Agent Adapter 与 Process Registration 共同固定 Tool 和 Capability 边界，海报与 CRT Agent 可以完全没有 Tool。

因此，不能把一个社区 extension 复制到 `.pi/skills/` 后就称为生产接入，也不应为了兼容它而关闭 `noExtensions`。如果某个 extension 的能力值得产品化，应先提取稳定业务语义，设计窄 Business Capability Interface 和 Adapter，绑定到准确版本的 Process Registration，再以确定性测试和显式真实集成或业务验收验证。外部调用方仍只选择 Business Process 和版本，不能选择 extension、Skill、MCP server 或 Tool 配置。
