# Agent Skill 来源、安装与运行生命周期调研

检索日期：2026-08-09

本文只使用 Agent Skills 官方规范、OpenAI/Codex 官方文档、Anthropic/Claude 官方文档、
GitHub/Copilot 官方文档与官方 CLI 手册。目标是回答：用户给出本地目录、Git 仓库或 URL
后，Agent 产品通常怎样获得、安装、调用和更新 Skill，以及这些模式如何迁移到本项目。

## 结论

“给 Agent 一个 Skill 的本地路径、Git 仓库或 URL，然后直接使用”这个判断总体正确，
但应区分两个 Interface：

- **Source Locator Interface** 负责说明 Skill 从哪里来；本地路径、Git 仓库和 URL
  是常见来源。
- **Runtime Skill Interface** 负责让 Agent 发现和激活已经可用的 Skill；通常面对的是本地
  目录、安装快照、版本化缓存或平台投影，而不是每次业务请求都重新下载远端内容。

Agent Skills 开放规范只规定 Skill 包内部的格式，没有规定统一的安装 URL、仓库协议、
缓存、锁文件或更新命令。其官方实现指南也明确说明，规范不强制 Skill 放在哪个目录，
本地 Agent、云端 Agent 和各客户端需要自行选择文件系统、注册中心、API 或打包资源等
发现方式。因此，“支持路径/仓库/URL”通常是产品的安装或配置能力，不是 `SKILL.md`
规范本身的能力。[Agent Skills 规范](https://agentskills.io/specification)、
[Agent Skills 客户端实现指南](https://agentskills.io/client-implementation/adding-skills-support)

主流实现的共同主路径可以概括为：

```text
Source locator
→ preview / trust decision
→ resolve exact revision
→ validate package
→ copy, install, register or cache locally
→ catalog name + description
→ activate SKILL.md on demand
→ load referenced resources on demand
→ explicit update / replacement
```

GitHub Copilot 还有一种组织级远程 Skill 例外：内容可在 Skill 被调用时经平台中继按需获取。
除此之外，官方文档中的普通本地、仓库和 marketplace 路径都以预先复制、安装、注册或缓存
为主。[GitHub Copilot CLI Skill locations](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#skills-reference)

## 开放规范规定了什么

一个可移植 Skill 至少是一个包含 `SKILL.md` 的目录。`SKILL.md` 必须包含 YAML
frontmatter 和 Markdown 正文；`name`、`description` 是必需字段，`name` 需符合小写字母、
数字、连字符规则并与父目录同名。目录可以附带 `scripts/`、`references/`、`assets/`
以及其他文件。[Agent Skills 规范](https://agentskills.io/specification)

规范定义了三级 progressive disclosure：

1. 会话发现阶段只加载全部 Skill 的 `name` 与 `description`。
2. Skill 被激活时加载完整 `SKILL.md`。
3. 脚本、参考资料和资产只在指令需要时加载。

规范建议 `SKILL.md` 保持在 500 行以内，详细内容拆到相对路径引用的资源文件；客户端实现
指南建议激活工具可以列出资源，但不应预读所有资源。
[Agent Skills progressive disclosure](https://agentskills.io/specification#progressive-disclosure)、
[客户端激活指南](https://agentskills.io/client-implementation/adding-skills-support#step-4-activate-skills)

`compatibility` 可以声明所需产品、系统包和网络等环境要求；`allowed-tools` 仍是实验字段，
不同实现的支持可能不同。`metadata` 是客户端可扩展的字符串映射，但规范没有赋予其中
`version`、来源或摘要任何统一的解析和更新语义。
[Agent Skills frontmatter](https://agentskills.io/specification#frontmatter)

由此可得两个约束：

- 单个远程 `SKILL.md` URL 只自然覆盖单文件 Skill；若正文引用脚本、参考资料或资产，来源
  必须能取得完整目录，例如 Git 仓库、归档或本地目录。
- 可移植 Skill 应只依赖开放规范字段。产品扩展字段可以使用，但必须在兼容性检查中明确
  哪些会被忽略、拒绝或翻译。

## 产品实现对比

<!-- markdownlint-disable MD013 -->

| 实现 | Source locator | 获取后的形态 | 调用时加载 | 更新与锁定 |
| --- | --- | --- | --- | --- |
| Agent Skills 开放规范 | 不规定；官方指南举例文件系统、API、远程 registry、上传包和 bundled assets | 由客户端决定 | 标准模式为 metadata → `SKILL.md` → resources | 不规定 |
| OpenAI Codex | 仓库、用户、管理员和系统目录；symlink；`$skill-installer` 可从其他仓库下载；跨仓库分发使用 plugin | 本地 Skill 目录或已安装 plugin；MCP 导入形成提交快照 | 按 description 隐式激活，或用 `$name` 显式调用；先 metadata，再完整 `SKILL.md` | 本地文件由仓库或用户管理；plugin 版本重新打包，MCP 来源修改后重新扫描 |
| GitHub Copilot CLI | 默认目录、自定义目录；`FILE\|URL\|DIRECTORY`；GitHub 仓库或本地仓库目录 | Directory 可注册为 source；file/URL 会复制；`gh skill` 会复制并写 provenance metadata | 一般按 description 自动激活或用 `/name` 手动激活 | `gh skill` 支持 tag/SHA pin、tree SHA 对比和显式 update |
| GitHub Copilot SDK | `skillDirectories` 本地目录数组 | Session 引用指定目录 | 普通 Session 可发现；绑定到 custom agent 的 Skill 会在 agent 启动时 eager preload | 由宿主应用管理 |
| VS Code + Copilot | 项目、用户默认目录及 `chat.agentSkillsLocations` 自定义路径；共享 Skill 可复制或随 plugin 安装 | 本地目录或已安装 plugin | progressive disclosure；也可 `/name` 手动调用 | 本地文件或 plugin 生命周期 |
| Claude Code | 项目、个人、enterprise、`--add-dir`、symlink；共享能力通过 plugin marketplace 接收 GitHub、Git URL、本地路径、npm 或 HTTPS archive 等来源 | 普通 Skill 可就地读取；marketplace plugin 会复制到本地版本化 cache | 常规会话按需激活；已调用内容在会话中保留 | 本地 Skill 可实时检测；plugin 支持 ref/SHA、archive SHA-256、版本 cache 和 update |

<!-- markdownlint-enable MD013 -->

### OpenAI Codex

Codex 从仓库、用户、管理员和系统位置发现本地 Skill。仓库级扫描范围包含从当前目录向上
直到仓库根目录的 `.agents/skills/`；Codex 也支持指向 Skill 目录的 symlink。Skill 可以用
`$name` 显式调用，也可以依赖 `description` 与用户目标匹配后隐式激活。
[OpenAI：Build skills](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)

OpenAI 把本地目录定位为 authoring 和仓库内流程的入口：用户可以让 `$skill-installer` 从其他
仓库下载 Skill；需要跨仓库分发、组合多个 Skill 或同时携带 Connector 时，官方建议打包成
plugin。[OpenAI：Install curated skills](https://learn.chatgpt.com/docs/build-skills#install-curated-skills-for-local-use)、
[OpenAI：Distribute skills with plugins](https://learn.chatgpt.com/docs/build-skills#distribute-skills-with-plugins)

Plugin 还说明了远程来源与运行时的边界：从 MCP server 导入 Skill 时，提交门户会把文件
保存为 draft snapshot；ChatGPT 和 Codex 不会在运行时从该 MCP server 重新获取。来源修改后
需要重新部署和扫描，才能形成新的 plugin 版本。
[OpenAI：Import a skill from MCP](https://developers.openai.com/plugins/build/skills#import-a-skill-from-mcp)

### GitHub Copilot

Copilot CLI 可以用 `copilot plugins install --skill <FILE|URL|DIRECTORY>` 添加 Skill。
官方命令参考明确区分：目录会被注册成自定义 Skill source，而 file 或 URL 的内容会复制到
个人或项目 Skill 目录。它也扫描项目、个人、plugin 和 `COPILOT_SKILLS_DIRS` 指定的目录。
[Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#installing-a-skill-non-interactively)

另一条官方路径是 GitHub CLI 的 `gh skill`：它从 `OWNER/REPO` 或本地目录发现 Skill，
把文件复制到目标 Agent 的项目或用户目录；仓库 Skill 可以指定 tag 或 commit SHA，安装后
frontmatter 会写入来源仓库、ref 和 tree SHA 等 provenance metadata。
[gh skill install](https://cli.github.com/manual/gh_skill_install)

`gh skill update` 用本地 tree SHA 与远端仓库比较；被 pin 的 Skill 默认跳过更新；`--dry-run`
只报告差异；`--force` 会重新下载并覆盖已安装文件的本地修改。手工安装且没有来源 metadata
的 Skill 在非交互批量更新时会被跳过。
[gh skill update](https://cli.github.com/manual/gh_skill_update)

Copilot 对同名 Skill 使用确定的优先级，“first found wins”；两个 plugin 中的同名 Skill
可以通过 plugin-qualified 名称共存，裸名称指向优先级更高的一个。Copilot SDK 则允许应用
在创建 Session 时直接提供本地 `skillDirectories`；若 custom agent 的 `skills` 字段指定
Skill，完整内容会在该 agent 启动时 eager preload，这是 progressive disclosure 的一个明确
宿主级例外。
[Copilot CLI 冲突规则](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#skill-locations)、
[Copilot SDK custom skills](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/skills)

### Anthropic Claude Code

Claude Code 的普通 Skill 来自 enterprise、`~/.claude/skills/`、项目 `.claude/skills/`
或 plugin。也可以通过 `--add-dir` 让外部目录中的 `.claude/skills/` 被发现，较新版本还允许
Skill 目录项使用 symlink。它监视普通 Skill 目录中的 `SKILL.md` 变化并在当前 Session
发现更新；但已经激活的渲染内容作为消息留在会话中，后续 turn 不会自动重读文件。
[Claude Code skills](https://code.claude.com/docs/en/skills)

Claude 的远程分发主要在 plugin/marketplace 层完成，而不是把任意远程 `SKILL.md` 当作
每次运行的内容源。Marketplace catalog 可以来自 GitHub、其他 Git URL、本地路径或远程
`marketplace.json`；plugin entry 支持 marketplace 内相对路径、GitHub、Git URL、Git
subdirectory、npm package 和 HTTPS archive。下载或 clone 后，plugin 会复制到
`~/.claude/plugins/cache` 的版本化目录。
[Claude marketplace sources](https://code.claude.com/docs/en/plugin-marketplaces#plugin-sources)、
[Claude plugin cache](https://code.claude.com/docs/en/plugins-reference#plugin-caching-and-file-resolution)

Git-based plugin source 可以 pin branch/tag 的 `ref` 或完整 commit `sha`，其中 `sha` 是实际
固定点；archive 可以 pin `sha256`。Claude 按显式 `version`、Git commit SHA 或 archive
digest 解析缓存版本；解析版本没有变化时跳过更新。安装后的旧版本会先标记为 orphan，延迟
清理，使仍在运行的旧 Session 不会立即丢失其文件。
[Claude plugin version resolution](https://code.claude.com/docs/en/plugin-marketplaces#version-resolution-and-release-channels)、
[Claude plugin cache lifecycle](https://code.claude.com/docs/en/plugins-reference#plugin-caching-and-file-resolution)

Claude 对普通同名 Skill 的优先级是 enterprise > personal > project > bundled；plugin Skill
使用 `plugin-name:skill-name` namespace。这个做法避免 plugin 与普通层级的同名冲突。
[Claude Skill locations and precedence](https://code.claude.com/docs/en/skills#where-skills-live)

## 安全与信任模式

Skill 不是纯静态说明。它可以改变 Agent 的行为、引用脚本、请求 Tool 权限，某些实现还会在
加载正文前执行动态 shell 插值。因此远程 Skill 应按“可执行依赖”而不是普通提示词对待。

官方材料给出的主要安全模式如下：

1. **安装前预览。** GitHub 明确说明 `gh skill` 找到的 Skill 未经 GitHub 验证，可能包含
   prompt injection、隐藏指令或恶意脚本，并要求先用 `gh skill preview` 检查文件树和
   `SKILL.md`。[GitHub：Adding agent skills](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills#managing-skills-with-github-cli)
2. **项目信任。** Agent Skills 客户端指南建议未受信仓库中的项目 Skill 先经过 workspace
   trust；Claude Code 的项目 Skill 只有在接受 workspace trust 后，`allowed-tools` 才能
   生效。[Agent Skills trust considerations](https://agentskills.io/client-implementation/adding-skills-support#trust-considerations)、
   [Claude tool pre-approval](https://code.claude.com/docs/en/skills#pre-approve-tools-for-a-skill)
3. **最小权限。** GitHub 警告预批准 `shell`/`bash` 会去掉逐次确认，并可能让恶意 Skill
   或 prompt injection 执行任意命令。开放规范中的 `allowed-tools` 又是实验字段，不能把它
   当成跨产品一致的安全策略。[GitHub script warning](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills#enabling-a-skill-to-run-a-script)、
   [Agent Skills allowed-tools](https://agentskills.io/specification#allowed-tools-field)
4. **来源限制。** Claude managed settings 可以 allowlist 或 block marketplace 来源，并在
   add、install、refresh、update 与 auto-update 的网络或文件操作前检查来源。
   [Claude marketplace restrictions](https://code.claude.com/docs/en/plugin-marketplaces#managed-marketplace-restrictions)
5. **内容固定和目录封闭。** GitHub 支持 tag/SHA pin 与来源 tree SHA；Claude 支持 Git SHA
   和 archive SHA-256。Claude 的安装 cache 不允许 plugin 引用自身目录外的文件，并跳过
   指向目录外的 symlink。[gh skill pinning](https://cli.github.com/manual/gh_skill_install)、
   [Claude path traversal limitations](https://code.claude.com/docs/en/plugins-reference#path-traversal-limitations)

对一个服务端运行的 Agent，还应在上述模式之外执行以下本项目策略：限制可访问的协议与
host、防止本地路径越过允许根目录、限制 bundle 大小和文件数、禁止归档路径穿越、验证
最终 realpath、默认不向 Skill 脚本传递服务凭证，并把下载与执行放在不同权限阶段。

## 对本项目的可迁移结论

### 当前能力

本项目已经有一个最小的本地路径入口：Startup Construction 可把
`PI_SKILL_DIRECTORY` 传给 [`PiContentOptimizationAgentRuntime`](../../src/processes/agent.ts)，
后者从该目录加载 Skill，并只保留准确名为 `content-optimization` 的一项。默认路径仍是
`.pi/skills/content-optimization`，Docker image 也只复制这一项
[`Dockerfile`](../../Dockerfile)。

所以当前“给一个本地路径即可用”只在以下约束下成立：

- 路径对服务进程或容器可见；
- 目录能被现有 Pi loader 读取；
- Skill 名必须仍是 `content-optimization`；
- 它只替换现有 Agent-backed Process 的 Skill Implementation，不会自动创建新的 Business
  Process；
- Agent 仍只能使用当前明确暴露的 `process_business_content` Tool。

当前没有 Git/URL 下载、来源 provenance、revision pin、digest lock、同名 catalog 或受审更新
流程。也不应为了远端来源把这些职责直接塞进 `PiContentOptimizationAgentRuntime.optimize`；
否则网络、认证、缓存、校验和业务执行会失去 Locality。

### 推荐的 Module 与 Seam

引入一个 `Skill Installer` Module，在 Source Locator 与 Runtime Skill 目录之间建立明确
Seam。它的 Interface 可以保持很小：输入一个来源描述和信任策略，返回一个经过验证、具有
固定 revision 与 digest 的 `InstalledSkill`。本地路径、Git 和 archive URL 已经是三个真实
变化来源，因此它们对应的 Adapter 是真实 Seam，不是假想抽象。

建议的最小来源模型：

```ts
type SkillSource =
  | { kind: "path"; path: string; mode: "linked" | "snapshot" }
  | {
      kind: "git";
      url: string;
      subdirectory?: string;
      commit: string;
    }
  | { kind: "archive"; url: string; sha256: string };
```

- `linked` 只用于本地开发：直接读取受信路径并方便即时修改。
- `snapshot`、Git 和 archive 用于可重复环境：复制完整目录到 content-addressed cache，记录
  来源、精确 revision、digest、Skill name、license/compatibility 和审核状态。
- 可以把 GitHub `owner/repo + path + tag/SHA` 在 Interface 边缘翻译成统一 `git` 来源，
  不必让运行时学习不同托管平台概念。
- 若确实需要接受单个 `SKILL.md` URL，应把它限定为 single-file Skill；一旦它引用资源，
  就拒绝并要求完整 Git/归档来源。

第二个 Module 是只读 `Installed Skill Catalog`。Startup Construction 从锁定 manifest 构造
catalog，并让每个 Process Registration 绑定准确的 installed skill id/revision；Pi Agent
Adapter 只接收已解析的本地目录和允许的 Tool，不负责远程获取。

建议运行链路：

```text
开发者提供 path / Git / archive URL
→ inspect 与静态验证
→ 人工或策略批准
→ 安装不可变快照并写 lock manifest
→ Startup Construction 校验并建立 catalog
→ Process Registration 绑定准确 Skill revision
→ 请求期间只从本地快照激活，不访问来源网络
```

### Process 与 Skill 的关系

Source locator 属于开发/运维 Interface，不应成为公共 `POST /execute` 的业务输入。允许普通
业务调用方在每个请求中传 URL，会同时改变信任域、延迟、可重复性、Tool 权限和供应链风险，
也会绕开显式 production catalog。

应保持以下规则：

- 用户简单描述一个新产品流程时，先封装新的或新版本的 Business Process，并定义稳定输入、
  输出和错误 Interface。
- 用户给出 Skill 路径或地址时，把它当成候选 Implementation：先 inspect/install，再绑定到
  明确 Process。
- 只替换实现且业务语义不变时，可保留 Process version；输入、输出、业务语义或公开错误变化
  时，新增 Process 或 version。
- 一个 Process 可以组合多个 Skill，但调用方仍只选择 Process，不直接选择任意 Skill。

### 冲突、权限和更新规则

生产 catalog 建议比通用桌面客户端更严格：

- 不对同名 Skill 静默使用优先级；若同一 catalog 出现重复 `name`，启动失败。确实要共存时，
  使用独立的 installed id（例如 `source-alias/name@revision`），不要修改不允许 `/`、`:` 的
  标准 `name` 字段。
- `allowed-tools` 只作声明和审核输入，不直接扩大权限。最终 Tool 集合由 Process/Agent
  Registration 显式给出。
- 当前 Agent 只开放一个窄业务 Tool，这是合适的默认值。第三方 Skill 如果声明 shell、网络
  或其他脚本能力，应先新增受控 Tool Adapter 或 sandbox；不能因 Skill 请求而自动开放通用
  shell。
- 更新必须生成新 revision 和 digest，先展示文件树与 diff，再显式批准并切换 binding。
  生产环境不跟随浮动 branch，也不在业务请求中 auto-update。
- Run Record 至少记录实际使用的 installed skill id、revision 和 digest，但不要保存完整 Prompt、
  模型隐藏过程或 Skill 中可能含有的 secret。

这套形状把下载、验证、缓存和更新复杂度隐藏在 `Skill Installer` 后，把运行时调用收敛为
“按准确 revision 取得一个已安装目录”。调用方获得较小 Interface，维护者则能在一个位置
处理全部来源规则，符合 Depth、Leverage 与 Locality。

## 可转成开发文档的操作约定

后续若要把研究结论变成仓库正式规范，建议最终让开发者看到三个简单动作，而把内部机制
隐藏起来：

1. `inspect SOURCE`：展示解析后的 name、description、文件树、脚本、兼容性、所需 Tool、
   来源 revision 和风险，不修改 catalog。
2. `install SOURCE`：验证并安装快照，生成或更新 lock manifest；本地 `linked` 模式必须显式
   选择。
3. `bind PROCESS@VERSION INSTALLED_SKILL_ID`：把准确 Skill revision 纳入 Process
   Registration 和测试；生产启动拒绝缺失、digest 不匹配和名称冲突。

默认验证至少覆盖：规范字段、名称与目录一致、引用资源存在、路径不越界、重复名、digest、
兼容性、Tool allowlist、无凭证文件，以及 Process 预期输出 Schema。真实模型 A/B 或 smoke
仍应作为独立、显式且可能产生费用的验证，不进入默认测试。
