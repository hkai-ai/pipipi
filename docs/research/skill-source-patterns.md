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

本项目已经有显式的本地 Skill 入口。各流程的 `skills.ts` 提供固定 `SkillRef[]`，共享的
[`src/agent-runtime/skills.ts`](../../src/agent-runtime/skills.ts) 负责精确加载。`content-processing/v1`
绑定 `content-optimization` 与 `content-integrity`；`minimal-zine-poster/v1` 绑定
`minimal-zine-poster-prompt`；`crt-interface-image/v1` 绑定 `tait-crt-interface-prompt`。Runtime 要求名称唯一、每项精确解析一次，并按声明顺序把选中的
`SKILL.md` 正文交给独立 Agent Session。Docker image 显式复制这四个 Skill
[`Dockerfile`](../../Dockerfile)。

所以当前多 Skill 能力只在以下约束下成立：

- 路径对服务进程或容器可见；
- 目录能被现有 Pi loader 读取；
- 每个 Skill 名和本地路径都必须由服务端绑定；`PI_SKILL_DIRECTORY` 只覆盖固定的
  `content-optimization` 路径，`PI_POSTER_SKILL_DIRECTORY` 与 `PI_CRT_SKILL_DIRECTORY` 分别只覆盖固定的图片 Prompt Skill 路径；
- 增加或替换 Skill 只改变现有 Agent-backed Process 的 Implementation，不会自动创建新的
  Business Process；
- 文本 Agent 只能使用 `process_business_content` Tool；海报与 CRT Agent 都没有 Tool。

两个图片 Runtime Skill 都已在同目录 `SOURCE.md` 记录上游仓库、原始 Skill digest、许可证、适配差异和
回滚方式，并由 `skills-lock.json` 固定原始 digest；CRT 来源没有许可证声明，因此仍有明确发布门禁。项目仍没有通用 Git/URL 下载、自动 revision
解析、同名 catalog 或受审更新流程。也不应为了远端来源把这些职责直接塞进 Agent Adapter；
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

## 私有 Skill Hub 与版本管理选型（2026-11-20 调研）

对于维护 Pipipi 的团队，建议先在现有 Git 仓库管理自有 Skill，借用现成工具发现和导入第三方 Skill。Agent Skills 规范允许用 `metadata.version` 标记版本，具体的版本解析、内容固定与发布授权由宿主决定。开发者可以委托 Codex 编写候选版本、比较差异和准备评审。生产 Agent 继续按 Process Registration 读取随服务发布的本地快照。[Agent Skills 规范](https://agentskills.io/specification)、[Pipipi 的 Skill 接入约定](../integrating-runtime-skills.md)

| 方案 | 已有能力 | 对 Pipipi 的意义 |
| --- | --- | --- |
| Git 私仓配合 Vercel `skills` CLI | CLI 使用已有 Git 凭证访问私仓，支持完整 commit 和指定 Skill，也能检查更新 | 适合多仓共享 Development Skill。导入 Runtime Skill 时，先在开发环境检查固定 commit 的完整目录，再按 Pipipi 的接入规则适配。[CLI 官方手册](https://github.com/vercel-labs/skills/blob/main/docs/commands.md) |
| Vercel skills.sh Packs | 可以组合公开和私有来源。持链接者无需登录即可查看和安装，新安装获取当前内容，构建器会省略二进制文件和超过 2 MB 的单文件 | 适合按链接分享可转发的开发材料。公司私有方法需要成员鉴权，含图片等资产的 Skill 还需要完整交付目录。[Packs 官方说明](https://skills.sh/docs/packs) |
| OpenClaw ClawHub | 托管服务公开发布文本 Skill，提供 SemVer、标签、变更说明和安装锁。MIT 源码可供自建，原项目使用 Convex 数据库与文件存储、GitHub OAuth 和向量搜索 | 可作公开候选来源。若多个独立团队确实需要网页检索、委托发布和独立分发，再评估自建实例的鉴权、存储和运维成本。[ClawHub 官方文档](https://docs.openclaw.ai/clawhub)、[ClawHub 源码与架构](https://github.com/openclaw/clawhub) |

建议先用一个实际升级验证版本策略。同一 Skill 的候选版应能与上版逐文件比较，记录其来源 commit 和实际交付内容的摘要；本地适配会改变内容，需分别记录上游标识与适配后标识。评审通过后，将固定版本绑定到对应 Registration 并随镜像发布。公开契约可保持原 Process 版本，同时保留 Skill 版本的变化记录。回滚时应能据此取回先前适配后的原件，而非重新从上游分支生成。以上是管理提案，当前接入和校验范围以[项目开发文档](../integrating-runtime-skills.md)为准。

### 用现有模板编译 Skill 验证提案

本次对本地 production catalog 启用可选的 composed-task 并运行启动校验，26 个含 Skill 的 Process 条目共绑定 24 个不同的 `name@version`。模板图的两个 Registration 共用 `meme-template-json-compiler@v1.13`。如果只让其中一个试用下一版，应保留 v1.13 的本地快照，为候选版指定独立路径并只切换目标 Registration。控制台已能展示当前 Skill 与 Process ID；如需区分同一 ID 下的不同 Process 版本，可从 Registration 补齐准确版本。[生产绑定](../../src/app/runtime-skills.ts)、[模板绑定](../../src/processes/template-from-image/production.ts)、[当前 Skill 版本](../../src/processes/template-from-image/skills.ts)、[控制台目录](../../src/api/skill-catalog.ts)

建议首先验证“已发布的同一名称和版本始终对应同一份执行内容”。现有启动校验比对本次发布提供的 `SKILL.md` SHA-256。可在 CI 中与前次已发布记录比较，防止一次修改同时覆盖旧正文和旧摘要。若 Schema 或其他文件参与执行，把这些文件纳入版本校验；封面等展示材料可独立更新。升级和退回都应验证已有异步任务能按受理时的约定继续执行。[加载与校验实现](../../src/agent-runtime/skills.ts)、[模板 Schema 摘要](../../src/processes/template-from-image/skills.ts)

当第二个独立服务需要消费同一份 Runtime Skill 时，可以先按 Git commit 取固定目录；若消费方需要独立包发布和权限，再评估 GitHub Packages 的私有 npm 包。Pi 上游也有 Git 和 npm 的精确版本分发机制。接入 Pipipi 时可由构建流程取包、校验并归入镜像，沿用当前离线执行路径。[Pi Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)、[GitHub Packages 权限](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages)

## 开源注册中心如何管理版本与来源

本节供维护 Pipipi Skill 的开发者比较注册中心的数据模型。以下比较基于 2026-11-20 查阅的上游实现与官方手册。选型首先取决于注册中心保存原件还是保存外部引用，以及发布版本能否追溯到上游修订。

### MLflow Skill Registry：版本记录绑定来源

MLflow 在 workspace 中按可选组织和名称维护 Skill，单次注册会生成递增的整数版本。每个版本独立记录来源类型、来源、可选摘要、状态、标签、创建人和时间。别名指向版本，因此可以移动 `production`，也可以按固定版本取件。这个组件标为 experimental，采用时需评估接口变化。[版本实体源码](https://github.com/mlflow/mlflow/blob/e5c0deed79d4ef35039161d7f466b6a92b021640/mlflow/entities/skill_version.py)、[实体与生命周期](https://mlflow.org/docs/latest/genai/skill-registry/)

本地上传由 MLflow 的 artifact store 留存。外部 Git、OCI、ZIP 默认保留来源引用，消费者拉取时仍需要能访问上游。Python 高层注册会验证内容并生成摘要，网页录入外部引用可以跳过取件；数据模型允许摘要为空。Git 来源可表达 URL、ref 和子目录。若用浮动 ref 且已记录摘要，来源漂移会导致后续拉取校验失败。需要历史回滚能力时，应保留可取得的原件。[来源注册与拉取规则](https://mlflow.org/docs/latest/genai/skill-registry/register-and-import-skills/)

### 讯飞 SkillHub：来源导入与内部发布分别留档

SkillHub 是 Apache-2.0 的自托管成品。PostgreSQL 保存元数据，文件内容由存储服务管理。核心关系是命名空间下的 Skill 拥有多个版本，每版对应一份文件清单，每个文件记录路径、大小、SHA-256 和存储位置。版本记录带发布人相关标识、状态、发布时间和变更说明，标签通过单独记录指向版本。团队可按命名空间管理权限与审核。[架构和部署](https://github.com/iflytek/skillhub/tree/b81af32f145c393c03051865031eae7bfbeaafa4)、[核心表与约束](https://github.com/iflytek/skillhub/blob/b81af32f145c393c03051865031eae7bfbeaafa4/server/skillhub-app/src/main/resources/db/migration/V2__phase2_skill_tables.sql)

GitHub 同步入口单独记录仓库 ID、40 位 commit、Skill 子路径、归档摘要，另有内容摘要与许可依据字段；发布版本可回链到这条导入记录。普通上传的版本可以没有 GitHub 导入记录。这个区分让使用者看得出哪些来源由系统在导入时采集，哪些只能由发布者提供。[GitHub 导入记录](https://github.com/iflytek/skillhub/blob/b81af32f145c393c03051865031eae7bfbeaafa4/server/skillhub-app/src/main/resources/db/migration/V82__github_sync_package_ingestion.sql)、[发布版本回链](https://github.com/iflytek/skillhub/blob/b81af32f145c393c03051865031eae7bfbeaafa4/server/skillhub-app/src/main/resources/db/migration/V89__github_sync_publication.sql)

### ClawHub：注册中心与消费方各自留存记录

服务端用 Convex 保存 Skill、发布版本及文件索引，文件存储保存对应字节。Skill 的标签指向版本记录；发布时检查同一 Skill 是否已存在相同版本。GitHub 导入由服务端解析 ref，留下仓库、commit、子路径和导入时间。验证接口能区分经服务端解析的来源和缺少来源证据的版本。[版本表](https://github.com/openclaw/clawhub/blob/6896b557703a97e23a04d1a6d8ee23029ee8f2f6/convex/schema.ts#L1055-L1100)、[发布检查](https://github.com/openclaw/clawhub/blob/6896b557703a97e23a04d1a6d8ee23029ee8f2f6/convex/lib/skillPublish.ts#L174-L218)、[来源验证](https://github.com/openclaw/clawhub/blob/6896b557703a97e23a04d1a6d8ee23029ee8f2f6/convex/httpApiV1/skillsV1.ts#L2478-L2491)

客户端安装完成后，工作区锁文件记录已装版本，还可记录是否固定；每个安装目录另存注册中心、版本和本地指纹。可由此区分中心当前推荐的版本和某个工作区上次实际安装的版本。[锁文件结构](https://github.com/openclaw/clawhub/blob/6896b557703a97e23a04d1a6d8ee23029ee8f2f6/packages/schema/src/schemas.ts#L14-L27)、[安装记录写入](https://github.com/openclaw/clawhub/blob/6896b557703a97e23a04d1a6d8ee23029ee8f2f6/packages/clawhub/src/cli/commands/skills.ts#L592-L615)

### 在 Pipipi 应如何对应这些信息（提案）

| 要回答的问题 | 应关联的信息 | 现有实例 |
| --- | --- | --- |
| 方法从哪里来，有权怎样使用？ | 仓库或原始包、准确修订、子路径或文件清单、许可 | 模板编译器的 [source-manifest.json](../../.pi/skills/print-design-template-compiler/source-manifest.json) 已记录上游修订和逐文件摘要 |
| 我们发布了哪个版本，如何取回？ | 本地 Skill 名称和版本、适配记录、执行文件摘要、快照所在 commit 或制品地址 | 模板的 [SOURCE.md](../../.pi/skills/print-design-template-compiler/SOURCE.md) 解释了从原始资料到内部 v3 的裁剪 |
| 当时由谁引入，为什么更新？ | 发布者、时间、变更说明及可追溯的评审记录 | Git 合并记录可作为依据，目录页面按需链接 |
| 哪个消费者实际采用？ | 精确 Process 身份和版本、Skill 版本、部署修订；发布别名可独立移动 | [生产绑定](../../src/app/runtime-skills.ts) 和随镜像发布的本地文件决定实际装载内容 |

上游 commit 标识仓库的历史，本地版本命名团队发布的适配结果，内容摘要校验交付字节，Process 绑定说明采用范围。即使同一上游 commit 经两次不同的裁剪生成两个内部版本，这四项仍能回答各自的问题。
