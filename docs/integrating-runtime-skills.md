# 从本地路径或远程来源集成 Skill

本文面向向 Codex 或生产 Agent 提供 Skill 的维护者。可以把本地路径、Git 仓库或网页地址交给 Codex，但这些地址是开发、安装或构建期的 Skill Source；生产业务请求只使用经过审查、固定版本并随应用发布的本地 Runtime Skill。

## 项目级 Agent 与 Skill

仓库中的“Agent + Skill”分为开发期和生产期。先区分调用方，再决定编辑位置：`AGENTS.md` 和 `.agents/skills/` 指导 Codex 开发仓库；`src/processes/` 中的流程专属 Agent Adapter、`src/agent-runtime/` 中的跨流程基础设施和 `.pi/skills/` 参与产品请求。Pi CLI 的 `.pi/extensions/` 或 `.pi/settings.json` 属于另一个开发宿主机制，本项目当前没有启用，也不进入生产 Runtime。

| 角色 | 位置 | 调用方 | 拥有的事实 |
| --- | --- | --- | --- |
| 仓库协作规则 | [`../AGENTS.md`](../AGENTS.md) | Codex、维护者 | 开发入口、术语、Skill 路由和完成标准；不定义生产 Agent 行为 |
| Development Skill | [`.agents/skills/<name>/`](../.agents/skills) | Codex | 编写、测试、集成、发布或维护文档的方法 |
| 生产 Agent Interface 与 Adapter | [`src/processes/<module>/agent.ts`](../src/processes)、`pi.ts`，跨流程基础设施在 [`src/agent-runtime/`](../src/agent-runtime) | Process Registration、生产 Composition Root | 模型任务、请求级 Session、JSON 解析和实际 Tool 表面；海报、CRT 与新闻图片 Adapter 复用无 Tool Structured Agent Session |
| Runtime Skill | [`.pi/skills/<name>/`](../.pi/skills) | 服务端受限 Agent | 经过评审的任务说明；它本身不授予 Tool、文件、Shell 或网络权限 |
| Installed Skill Catalog | [`src/agent-runtime/catalog.ts`](../src/agent-runtime/catalog.ts)、[`src/app/runtime-skills.ts`](../src/app/runtime-skills.ts) | Startup Construction、部署预检 | 已安装 Skill 的准确名称、版本和 SHA-256；启动期完整性校验、精确版本解析和 Process 绑定 |
| 服务端绑定与流程治理 | `src/processes/<module>/skills.ts`、`registration.ts`，[`src/app/business-processes.ts`](../src/app/business-processes.ts)、[`src/processes/catalog.ts`](../src/processes/catalog.ts) | Startup Construction、Process Runner | 准确 Skill 集合、Agent 与 Capability Adapter、执行顺序、校验、错误、重试和 production catalog |

部署预检和启动过程都通过 Installed Skill Catalog 校验全部本地 Runtime Skill，并按准确名称和版本向各 Agent 提供绑定。生产请求到达后，production catalog 精确找到 Process Registration；Registration 执行业务定义；需要模型任务时调用窄 Agent Interface；Pi Adapter 只加载已绑定的 Runtime Skill，并只提供代码中显式配置的 Tool；Registration 再校验结果并决定是否调用 Business Capability。Runtime Skill 影响模型如何完成任务，不拥有流程、权限或副作用。

### 当前生产流程定位

| 流程 | 流程与校验 | Agent | Skill 绑定与正文 | Capability | 契约与业务验收 |
| --- | --- | --- | --- | --- | --- |
| `content-processing/v1` | [`content/registration.ts`](../src/processes/content/registration.ts) | [`content/agent.ts`](../src/processes/content/agent.ts)、[`content/pi.ts`](../src/processes/content/pi.ts) | [`content/skills.ts`](../src/processes/content/skills.ts)、[`content-optimization`](../.pi/skills/content-optimization/SKILL.md)、[`content-integrity`](../.pi/skills/content-integrity/SKILL.md) | [`content/capability.ts`](../src/processes/content/capability.ts)、[`content/http.ts`](../src/processes/content/http.ts) | [`processes/common/content-processing/`](processes/common/content-processing/)、[`test/agent-runtime.test.ts`](../test/agent-runtime.test.ts)、[`test/runtime-skills.test.ts`](../test/runtime-skills.test.ts)、[`test/execute-process.test.ts`](../test/execute-process.test.ts)、[`examples/agent-smoke.ts`](../examples/agent-smoke.ts) |
| `minimal-zine-poster/v1` | [`poster/registration.ts`](../src/processes/poster/registration.ts) | [`poster/agent.ts`](../src/processes/poster/agent.ts)、[`poster/pi.ts`](../src/processes/poster/pi.ts) | [`poster/skills.ts`](../src/processes/poster/skills.ts)、[`minimal-zine-poster-prompt`](../.pi/skills/minimal-zine-poster-prompt/SKILL.md) | [`poster/capability.ts`](../src/processes/poster/capability.ts)、[`poster/http.ts`](../src/processes/poster/http.ts) | [`processes/common/minimal-zine-poster/`](processes/common/minimal-zine-poster/)、[`test/poster-process.test.ts`](../test/poster-process.test.ts)、[`test/runtime-skills.test.ts`](../test/runtime-skills.test.ts)、[`examples/poster-business-acceptance.ts`](../examples/poster-business-acceptance.ts) |
| `crt-interface-image/v1` | [`crt/registration.ts`](../src/processes/crt/registration.ts) | [`crt/agent.ts`](../src/processes/crt/agent.ts)、[`crt/pi.ts`](../src/processes/crt/pi.ts) | [`crt/skills.ts`](../src/processes/crt/skills.ts)、[`tait-crt-interface-prompt`](../.pi/skills/tait-crt-interface-prompt/SKILL.md) | [`crt/capability.ts`](../src/processes/crt/capability.ts)、[`crt/http.ts`](../src/processes/crt/http.ts) | [`processes/common/crt-interface-image/`](processes/common/crt-interface-image/)、[`test/crt-process.test.ts`](../test/crt-process.test.ts)、[`test/crt-http.test.ts`](../test/crt-http.test.ts)、[`examples/crt-gpt-image-smoke.ts`](../examples/crt-gpt-image-smoke.ts) |
| Memene 的三个新闻图片 Process | [`news-image/`](../src/processes/news-image) | [`news-image/pi.ts`](../src/processes/news-image/pi.ts) | `news-image-narrative-monument-prompt`、`news-image-pale-watercolor-prompt`、`news-image-raw-humanism-prompt` | 复用 [`news-image/capability.ts`](../src/processes/news-image/capability.ts) 与 [`news-image/http.ts`](../src/processes/news-image/http.ts) | [`processes/memene/`](processes/memene/)、[`api.md`](api.md) |

要修改流程顺序、校验、失败或副作用，先编辑 `registration.ts`；要修改模型交互或 Tool 暴露，编辑 `agent.ts` 和具体 Adapter；要修改获准 Skill 名称、版本、SHA-256、顺序或路径，编辑 `skills.ts` 和生产 Composition Root；要修改模型任务说明，编辑对应 `.pi/skills/<name>/SKILL.md`，并同步更新固定哈希。新增 Process 还必须更新显式 production catalog。

## 两类 Skill

本项目区分两种用途：

| 类型 | 目录 | 调用方 | 用途 |
| --- | --- | --- | --- |
| Development Skill | `.agents/skills/<name>/` | Codex | 规范开发、测试、发布或文档维护流程 |
| Runtime Skill | `.pi/skills/<name>/` | 服务端受限 Agent | 完成某个 Business Process 内的模型任务 |

两类 Skill 都可以采用包含 `SKILL.md` 和可选资源的目录结构，但权限和发布方式不同。Development Skill 可以指导 Codex 修改仓库；Runtime Skill 只能获得 Process Registration 明确授权的 Tool，也可以完全没有 Tool。把第三方目录复制到 `.pi/skills/` 不会自动让它适合生产。

## 可以怎样提供来源

你可以直接给 Codex 以下任一种输入：

```text
把 /Users/me/skills/article-review 作为 Runtime Skill 接入文章审核流程。
```

```text
请先读取 /Users/me/skills/article-review/SKILL.md，再用它处理这个仓库。
```

```text
使用 https://github.com/example/agent-skills/tree/v1.2.0/skills/article-review ，先审查，再集成到这个项目。
```

```text
$integrate-runtime-skill source=https://github.com/example/agent-skills.git ref=8f23... path=skills/article-review target=development
```

支持的来源形式如下：

| 来源 | 最少信息 | 处理规则 |
| --- | --- | --- |
| 本地目录或 `SKILL.md` | 绝对路径或仓库相对路径 | 从文件回到所属目录并读取完整 Skill；共享前复制快照，避免依赖仓库外路径 |
| Git 仓库 | clone URL，可选 ref 和子目录 | 解析为 commit SHA，再读取目标目录 |
| GitHub/GitLab 目录页 | 页面 URL | 还原仓库、ref 和子目录；不能只下载页面正文 |
| 单个 `SKILL.md` URL | 文件 URL | 先查找所属目录和引用资源；孤立文件只可用于预览 |
| 归档 URL | URL 和发布方提供的校验值 | 在临时位置解包、校验并审查；生产使用必须固定内容哈希 |

远程来源若没有明确 ref，可以用于预览，但进入共享仓库或生产前必须固定到不可变 commit、release 或内容哈希。浮动分支不能作为生产版本。

## 集成流程

### 选择目标

先判断 Skill 服务于谁：

- 帮 Codex 开发这个仓库，目标是 Development Skill；
- 帮线上 Agent 完成一个 Business Process，目标是 Runtime Skill；
- 同时服务两者时分别集成和验证，不让一个高权限开发 Skill 直接继承到生产。

若用户描述了产品流程但没有明确目标，优先把它视为 Runtime Skill；若用户只要求以后让 Codex 遵循某套开发步骤，优先把它视为 Development Skill。

### 解析并审查来源

所有来源先以只读方式解析到本地临时目录。集成前必须：

1. 读取完整 `SKILL.md` 和它引用的必要文件；
2. 清点 scripts、references、assets、MCP 和 Tool 依赖；
3. 检查脚本的命令执行、网络访问、Secret 读取、文件写入和删除范围；
4. 确认名称、描述、许可证、来源仓库、解析后的 ref 和内容哈希；
5. 判断当前宿主是否支持 Skill 需要的资源和权限；
6. 在执行任何第三方脚本前向用户说明外部影响，并遵守当前授权边界。

Skill 是可执行指令，不是普通说明文件。来源可信不等于内容安全；更新后的版本要重新审查。

### 安装 Development Skill

个人临时使用可以安装到用户 Skill 目录，或在宿主支持时引用符号链接。需要和仓库一起评审、复现和发布时，应把固定快照放到 `.agents/skills/<name>/`，并保留来源、路径和内容哈希等 provenance。外部 Skill 的现有可复现记录位于 [`../skills-lock.json`](../skills-lock.json)。

Codex 会扫描仓库根目录的 `.agents/skills/`。安装后可以用 `$skill-name` 显式调用，也可以直接描述与 `description` 匹配的任务，让 Codex 隐式选择；如果新 Skill 没有立即出现，重启 Codex 后再验证。

安装后运行结构校验，并用一个会触发该 Skill 的真实开发请求验证显式和隐式调用。修改来源版本属于新的依赖更新，不静默跟随远程分支。

### 安装 Runtime Skill

Runtime Skill 必须服务于一个明确的 Process Registration。集成步骤是：

1. 把审查后的固定快照放入 `.pi/skills/<name>/`，并在流程 `skills.ts` 中固定名称、版本和 `SKILL.md` SHA-256；
2. 确认 Runtime 能加载 Skill 需要的全部资源；
3. 为该任务建立或复用受限 Agent Runtime；只授予必要的窄 Business Capability Tool，不需要 Tool 时保持空集合；
4. 在流程 Module 中定义一个经过整体评审的本地 Skill/Tool 集合，并由 Registration factory 绑定 Agent、Schema、调用 invariant 和稳定策略；
5. 把 Registration 显式加入 production catalog；
6. 更新 Dockerfile 或其他发布清单，确保快照进入不可变制品；
7. 用 mock Agent 做确定性契约测试，再按需运行显式的真实集成或业务验收；
8. 记录来源、不可变 ref、内容哈希、适配改动和回滚版本。

当前 Pi Agent 路径接受非空 `SkillRef[]`。具体 Process 的 `skills.ts` 固定 Skill 名称、版本、`SKILL.md` SHA-256、顺序、默认本地路径和 Tool 名称。生产 Composition Root 用 [`src/agent-runtime/catalog.ts`](../src/agent-runtime/catalog.ts) 构造只读 Installed Skill Catalog；Catalog 在监听端口前校验全部安装项，并且只解析准确的 `name@version`，不回退到其他版本。通用 [`src/agent-runtime/skills.ts`](../src/agent-runtime/skills.ts) 负责精确加载和再次校验内容完整性。名称必须唯一，并且必须精确解析一次。Runtime 按声明顺序读取所有 `SKILL.md`，把正文作为一个经过评审的指令集交给 Agent，同时只暴露 Registration 已授权的 Tool。海报、CRT 与新闻图片 Adapter 还复用 [`src/agent-runtime/structured.ts`](../src/agent-runtime/structured.ts)，由该 Module 统一创建无 Tool、请求级隔离的 Pi Session，并处理模型选择、取消、释放和 JSON 解析；流程 Adapter 仍拥有业务指令、用户 Prompt 和流程专属结果约束。`content-processing/v1` 最多让一次 Tool 调用触达 Business Capability，并要求成功输出与 Tool 结果一致。`minimal-zine-poster/v1`、`crt-interface-image/v1` 与三个新闻图片流程都不给 Agent Tool；Registration 先验证 Agent 编译结果，再自行调用对应 Rendering Capability。Runtime 不自动发现目录、下载或更新 Skill，也不读取附加 reference、运行 Skill script 或连接 MCP。需要这些能力的 Skill 不能直接接入；应先设计窄 Runtime Interface、权限和测试，再扩展实现。当前限制和真实验证方法见 [`experiments.md`](experiments.md)。

## 线上边界

生产 `/execute` 请求不能包含 Skill 名称、路径、URL、Git ref 或 Tool 配置。请求只选择准确的 Business Process 和版本；服务端 Registration 决定使用哪个已发布 Skill 集合。

因此，以下模式不进入本项目：

- 按每个请求从 URL 下载并运行 Skill；
- 让产品调用方覆盖已绑定 Skill；
- 对浮动分支自动更新生产 Skill；
- 为兼容任意第三方 Skill 向 Agent 开放 Shell、文件系统或通用网络访问；
- 扫描目录后自动加入 production catalog。

这条边界把供应链检查、权限审查和发布回滚留在服务端，也保持产品 Interface 稳定。

## 当前能力与提案

当前每个新闻风格都由一个语义化、精确版本的 Process Registration 绑定一个准确 Runtime Skill，并复用受控图片 Capability。生产组装和确定性测试共用 `src/processes/news-image/skills.ts`；各路径覆盖只替换固定路径，不改变绑定名称或集合。

海报 Runtime Skill 是上游 `gc-minimal-zine-poster-v0-1` 的受限适配。`.pi/skills/minimal-zine-poster-prompt/SOURCE.md` 记录上游仓库、原始 `SKILL.md` SHA-256、许可证、审查清单、适配差异和回滚方式；`skills-lock.json` 固定同一上游哈希。快照不包含仅供展示的 JPEG，也移除了内置图片生成权限。项目已有只读 Installed Skill Catalog，但仍没有通用 Git/URL 下载器或自动 revision 解析；单项 provenance 记录和运行期 Catalog 都不等于通用安装机制。

CRT Runtime Skill 是 `TaiT-tt/tait-crt-interface-skill` 在 commit `972a99bc85f725537bddadae6a6cea53516470f2` 上的受限 Prompt 编译适配。`.pi/skills/tait-crt-interface-prompt/SOURCE.md` 记录完整文件清点、内容哈希、脚本权限审查、适配差异和回滚方式；`skills-lock.json` 固定上游 `SKILL.md` 哈希。生产快照不含示例图片、交互资产或 Python finalizer，Agent 也不能读取参考图、调用图片模型或执行脚本。上游 Git tree 没有许可证声明，因此 `NOASSERTION` 是发布门禁，不是默认授权。具体 Process 开发见 [`processes/common/crt-interface-image/`](processes/common/crt-interface-image/)。

三个新闻图片 Runtime Skill 来自同一本地来源包的三个固定快照。语义名称分别描述人物叙事碑式封面、淡彩绘本和原质人文主义；各 `SOURCE.md` 记录哈希、脚本权限和适配差异。生产不执行来源脚本、不读取任意文件，也不直接调用图片模型。来源没有许可证声明，因此正式发布前必须解除 `NOASSERTION` 门禁。

只读 Installed Skill Catalog 已实现；它管理随应用发布的本地安装事实，不负责取得来源。若后续要把多个外部来源自动化为生产快照，可新增开发期 `Skill Installer`，把 path、Git 或 archive URL 解析为经过验证、带固定 revision 和 digest 的本地快照，再更新代码定义的安装项。Installer 不进入 `/execute` 请求路径；这一开发期 Installer 仍是提案。

## 更新与回滚

Skill 更新按依赖升级处理：解析新的不可变版本，比较目录差异，重新做安全和能力审查，更新 `skills.ts` 中的版本与 SHA-256，运行确定性测试与明确需要的真实集成或业务验收，再发布新的应用制品。出现回归时回滚应用制品或恢复上一个固定快照；不要在运行实例上原地拉取旧分支。

业界实现与这一判断的官方资料摘要见 [`research/skill-source-patterns.md`](research/skill-source-patterns.md)。
