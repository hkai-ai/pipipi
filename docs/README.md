# 文档索引与维护规范

本页是仓库文档的统一入口，也规定每类文档的职责、位置和更新方式。目标是让读者先找到正确文档，再从一个稳定入口获得完整答案。

## 文档地图

### 项目说明

| 文档 | 职责 | 变更触发条件 |
| --- | --- | --- |
| [`../README.md`](../README.md) | 说明项目是什么、当前能力、最短体验路径和文档入口 | 产品能力、公开 Interface 或快速开始变化 |
| [`../CONTEXT.md`](../CONTEXT.md) | 记录项目目的、范围、信任模型和共同语言 | 产品方向、范围、核心约束或术语变化 |

项目说明面向第一次接触仓库的人。它描述当前事实，不承担详细实现、实验记录或发布操作。

### 开发文档

| 文档 | 职责 | 变更触发条件 |
| --- | --- | --- |
| [`development.md`](development.md) | 说明开发环境、代码地图、常见改动路径和验证要求 | 目录、命令、开发流程或完成标准变化 |
| [`authoring-business-processes.md`](authoring-business-processes.md) | 说明如何把自然语言流程描述封装为 Business Process | 流程需求入口、authoring 步骤或完成标准变化 |
| [`integrating-runtime-skills.md`](integrating-runtime-skills.md) | 说明如何从本地或远程来源审查、固定并接入 Skill | Skill 来源、权限、安装、更新或 Runtime 边界变化 |
| [`process-runtime-design.md`](process-runtime-design.md) | 记录 Process Runtime 的 Module、Interface、invariant 和测试面 | Seam、Interface、执行顺序或错误归属变化 |
| [`experiments.md`](experiments.md) | 说明真实 Agent、Skill、图片和存储集成如何验证 | 实验命令、判据、成本或产物位置变化 |

开发文档面向修改 Implementation 的人。它应解释为什么 Seam 放在这里、调用方必须遵守什么，以及如何通过 Interface 验证行为。

### 发布与运维文档

| 文档 | 职责 | 变更触发条件 |
| --- | --- | --- |
| [`mvp-release-runbook.md`](mvp-release-runbook.md) | 给出受控文本 MVP 的部署、验收、观测和回滚步骤 | 发布范围、平台约束、配置或门禁变化 |

Runbook 必须可按顺序执行。每一步都应说明前置条件、成功信号和失败后的安全动作。

### 证据与生成内容

`artifacts/` 保存实验输出和证据报告，不是规范性文档。报告由命令生成，不手工编辑；需要长期保留的结论应写入对应开发文档，并链接可复现命令。

`.agents/skills/` 与 `.pi/skills/` 是运行资源。Skill 的 `SKILL.md` 约束 Agent 行为，不替代项目说明或开发文档。两类 Skill 的来源与接入规则见 [`integrating-runtime-skills.md`](integrating-runtime-skills.md)。

`research/` 保存基于外部一手资料的带来源调研，不直接定义项目行为。当前 Skill 来源调研见 [`research/skill-source-patterns.md`](research/skill-source-patterns.md)；项目采用的规则以 [`integrating-runtime-skills.md`](integrating-runtime-skills.md) 为准。

## 分类与放置

新增文档前先确定读者要完成的任务：

- 想理解项目：更新根目录 `README.md` 或 `CONTEXT.md`。
- 想修改代码：更新 `docs/development.md` 或对应 `*-design.md`。
- 想把自然语言流程封装为产品能力：阅读或更新 `docs/authoring-business-processes.md`。
- 想安装或接入 Skill：阅读或更新 `docs/integrating-runtime-skills.md`。
- 想运行实验：更新 `docs/experiments.md`。
- 想部署或恢复服务：更新对应 `*-runbook.md`。
- 想记录不可逆或跨 Module 的设计决定：新增 `docs/decisions/YYYY-MM-DD-short-topic.md`。

不要为一次小改动新建独立文档。能在现有文档的明确职责内回答的问题，直接更新该文档。

文件名使用小写 kebab-case。根目录只保留仓库级入口、许可证和工具要求的标准文件；专题文档放在 `docs/`。

## 规范性来源

同一事实只保留一个规范性来源，其他文档用链接和短摘要引导：

- 目的、范围和术语以 [`../CONTEXT.md`](../CONTEXT.md) 为准。
- 精确行为、默认值和错误映射以 `src/` 与 `test/` 为准。
- 环境变量清单以 [`.env.example`](../.env.example) 和配置解析测试为准。
- Module 设计以对应 `*-design.md` 为准。
- 发布步骤以对应 `*-runbook.md` 为准。

README 不复制完整配置表、实验手册或发布步骤。设计文档不复制函数实现。Runbook 可以列出本次发布必须固定的配置值，但应明确它们是发布覆盖值还是代码默认值。

文档也要通过 deletion test：删除一份文档后，如果没有知识丢失，或读者仍能在另一处得到同样完整的答案，这份文档通常只是重复层。合并它，保留更深的文档。

## 内容要求

每份文档必须做到：

1. 开头说明读者、目的和范围。
2. 先写当前结论，再写使用或验证方法。
3. 区分当前能力、明确限制和未来设想。尚未实现的内容必须标为“提案”或“计划”。
4. 描述 Interface 时同时写清输入输出、invariant、调用顺序、错误、配置和性能约束；不要只列 TypeScript 类型。
5. 描述设计时使用 `CONTEXT.md` 中的共同语言，以及 Module、Interface、Implementation、Seam、Adapter、Depth、Leverage 和 Locality。
6. 命令默认从仓库根目录执行。涉及网络、真实凭证、模型费用、外部写入或删除时，必须在命令前提示。
7. 示例必须使用假域名、占位凭证和非敏感业务内容。禁止记录 `.env`、AccessKey、签名 URL、Prompt 私密内容或远端原始错误。
8. 链接到仓库文件时使用相对路径；链接文字要说明目标，不使用“这里”。

设计一个新的 Seam 前先确认至少存在两个 Adapter，或已经有确定的替换需求。一个 Adapter 只证明存在一种 Implementation，不证明需要新的 Interface。

## 写作与 Markdown

- 仓库文档以中文为主；代码标识、环境变量、错误码和固定领域词保持原文。
- 使用主动语态、肯定句和具体名词。删掉不影响含义的开场白、重复总结和模糊程度词。
- 一个段落只表达一个主题；段首先给结论。
- 每份 Markdown 只有一个一级标题。标题使用描述性短语，不手工编号。
- 三项以上的固定映射优先使用表格；只有关系或执行顺序难以用短段落说明时才使用 Mermaid。
- 代码块标明语言；JSON 示例必须是有效 JSON；Shell 示例应可复制执行。
- 不强制硬换行。编辑现有段落时遵循该文件的排版，不为换行制造无意义 diff。
- 时间敏感事实写明绝对日期，格式使用 `YYYY-MM-DD`。无需追踪时效的文档不要添加容易过期的“最后更新”字段。

## 设计记录格式

只有跨 Module、难以逆转或需要保留取舍背景的决定才新建设计记录。文件放在 `docs/decisions/`，结构如下：

```markdown
# 决定标题

状态：提议 | 已接受 | 已替代

## 背景

问题、约束和已验证事实。

## 决定

采用的决定，以及涉及的 Interface 和 Seam。

## 后果

获得的 Leverage、Locality、代价和后续约束。
```

小范围实现选择留在代码和测试中。不要用设计记录代替当前设计文档；决定被采用后，仍要把当前状态写入对应 `*-design.md`。

## 随代码更新

| 代码变化 | 同一改动中检查的文档 |
| --- | --- |
| 新增或修改 Business Process | `README.md`、`CONTEXT.md`、`development.md`、Process Runtime 设计 |
| 新增或更新 Development Skill | `integrating-runtime-skills.md`、`AGENTS.md`、`skills-lock.json`（外部来源） |
| 新增或更新 Runtime Skill | `integrating-runtime-skills.md`、`experiments.md`、对应 Process 文档和发布清单 |
| 修改公开请求、响应或错误 | `README.md`、`CONTEXT.md`、Process Runtime 设计、相关 Runbook |
| 修改 Module Interface 或 Seam | 对应 `*-design.md`、`development.md` |
| 新增环境变量或改变默认值 | `.env.example`、`development.md`、相关 Runbook |
| 修改测试或实验命令 | `development.md` 或 `experiments.md` |
| 修改部署范围、容量或回滚方式 | 对应 Runbook、README 的当前边界 |
| 修改项目目的、范围或共同语言 | `CONTEXT.md`，再检查全部入口文档 |

删除能力时同步删除失效说明、链接和示例。不要留下“暂时保留”的旧步骤；版本历史由 Git 保存。

## 评审清单

提交文档前确认：

- 内容位于正确分类，没有制造第二个规范性来源；
- 术语与 `CONTEXT.md` 一致；
- 命令、路径、链接、配置名和示例与当前仓库一致；
- 当前能力与提案明确分开；
- 外部调用、费用、Secret 和破坏性动作已提示；
- Interface 的约束和错误没有被简化成只有类型；
- 改动删除了过期内容，而不只是叠加新说明。
