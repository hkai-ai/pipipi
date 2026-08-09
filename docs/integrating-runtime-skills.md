# 从本地路径或远程来源集成 Skill

本文面向向 Codex 或生产 Agent 提供 Skill 的维护者。可以把本地路径、Git 仓库或网页地址交给 Codex，但这些地址是开发、安装或构建期的 Skill Source；生产业务请求只使用经过审查、固定版本并随应用发布的本地 Runtime Skill。

## 两类 Skill

本项目区分两种用途：

| 类型 | 目录 | 调用方 | 用途 |
| --- | --- | --- | --- |
| Development Skill | `.agents/skills/<name>/` | Codex | 规范开发、测试、发布或文档维护流程 |
| Runtime Skill | `.pi/skills/<name>/` | 服务端受限 Agent | 完成某个 Business Process 内的模型任务 |

两类 Skill 都可以采用包含 `SKILL.md` 和可选资源的目录结构，但权限和发布方式不同。Development Skill 可以指导 Codex 修改仓库；Runtime Skill 只能获得 Process Registration 明确授权的窄 Tool。把第三方目录复制到 `.pi/skills/` 不会自动让它适合生产。

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

1. 把审查后的固定快照放入 `.pi/skills/<name>/`；
2. 确认 Runtime 能加载 Skill 需要的全部资源；
3. 为该任务建立或复用受限 Agent Runtime，只授予窄 Business Capability Tool；
4. 在 Registration factory 中绑定一个经过整体评审的本地 Skill 集合、Agent、Schema 和稳定策略；
5. 把 Registration 显式加入 production catalog；
6. 更新 Dockerfile 或其他发布清单，确保快照进入不可变制品；
7. 用 mock Agent 做确定性契约测试，再按需运行单独的真实模型 smoke；
8. 记录来源、不可变 ref、内容哈希、适配改动和回滚版本。

当前 Pi Agent 路径接受非空 `SkillRef[]`。每项引用固定 Skill 名称和本地路径；名称必须唯一，并且必须精确解析一次。Runtime 按声明顺序读取所有 `SKILL.md`，把正文作为同一个经过评审的指令集交给 Agent，同时只暴露 Registration 已授权的 Tool。Runtime 不自动读取附加 reference、运行 Skill script 或连接 MCP。需要这些能力的 Skill 不能直接接入；应先设计窄 Runtime Interface、权限和测试，再扩展实现。当前限制和真实验证方法见 [`experiments.md`](experiments.md)。

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

当前 `content-processing/v1` 绑定 `content-optimization` 和 `content-integrity`。`PI_SKILL_DIRECTORY` 只替换前者的本地路径；后者仍使用随应用发布的固定快照。Runtime 会拒绝空集合、重名绑定和无法精确解析的名称。项目仍没有 Git/URL 下载、来源 provenance、revision pin、digest lock 或通用 Runtime Skill catalog。

若后续要把多个外部来源自动化为生产快照，新增开发期 `Skill Installer` 和只读 `Installed Skill Catalog`。前者把 path、Git 或 archive URL 解析为经过验证、带固定 revision 和 digest 的本地快照；后者让 Startup Construction 和 Process Registration 只绑定准确的 installed Skill。两者都不进入 `/execute` 请求路径。该设计目前是提案，不是已实现能力。

## 更新与回滚

Skill 更新按依赖升级处理：解析新的不可变版本，比较目录差异，重新做安全和能力审查，运行确定性测试与 smoke，再发布新的应用制品。出现回归时回滚应用制品或恢复上一个固定快照；不要在运行实例上原地拉取旧分支。

业界实现与这一判断的官方资料摘要见 [`research/skill-source-patterns.md`](research/skill-source-patterns.md)。
