# 从流程描述封装 Business Process

本文面向希望把一段业务流程交给 Codex 实现的项目维护者。你可以只描述目标、输入和结果；Codex 负责把描述收敛为版本化契约、代码拥有的 Process Definition、显式 Process Registration、测试和文档。生产 Runtime 仍以 [`../CONTEXT.md`](../CONTEXT.md) 的范围和共同语言为准。

## 使用入口

直接描述流程即可，不需要先写技术方案或工作流配置。例如：

> 帮我封装一个“文章发布前检查”流程。输入标题和正文，先做格式清理，再检查禁用词；通过时返回清理后的内容和检查结果，不通过时返回稳定的业务错误。第一版不真正发布文章。

也可以显式调用仓库 Skill：

```text
$author-business-process 把上面的流程做成新的 Business Process。
```

一段可执行的最小描述通常包含三项：

| 信息 | 要回答的问题 | 示例 |
| --- | --- | --- |
| 业务目标 | 调用方想完成什么 | 发布前检查文章 |
| 输入 | 调用方提供什么 | 标题和正文 |
| 输出 | 成功后需要什么 | 清理后的内容和检查结果 |

以下信息可以在已知时补充：公开失败、外部依赖、副作用、性能要求、版本兼容、数据敏感性和验收样例。缺失信息若能从现有契约安全推断，Codex 会写明假设并继续；只有不同答案会改变公开契约、权限或不可逆副作用时才需要先确认。

## 封装流程

### 确认变化类型

Codex 先把需求归入一种变化：

- 新业务用例使用新的 Business Process `id` 和首个明确版本；
- 已发布版本的公开输入、输出或语义发生不兼容变化时新增版本；
- 只替换内部 Adapter、Agent 或算法且契约不变时修改现有 Implementation。

已发布的 `(id, version)` 代表准确契约。不能用 `latest`、默认版本或版本回退掩盖变化。

### 先固定 Interface

在写实现前，先明确：

- 输入和输出 Schema；
- 公开成功语义与稳定错误；
- 超时、取消、并发和副作用边界；
- 需要调用的窄 Business Capability；
- 是否需要受限 Agent，以及它获准使用的 Skill 和 Tool。

产品调用方只学习这些 Interface 事实。Prompt、供应商 SDK、远程协议、Skill 来源和执行细节留在服务端 Implementation。

### 把复杂度放进现有 Seam

每个版本由一个 Registration factory 聚合 Schema、Process Definition、获准依赖和稳定策略。优先复用现有 Business Capability；远程协议、认证和供应商错误留在 Adapter 内。只有两个真实 Adapter 或确定的替换需求才能证明需要新 Seam。

如果流程依赖外部 Skill 来源，先按 [`integrating-runtime-skills.md`](integrating-runtime-skills.md) 解析、审查并固定来源，再把一个或多个本地 Runtime Skill 作为完整集合绑定到该流程。Skill 地址不能成为产品输入。

`minimal-zine-poster/v1` 是现有的两阶段示例。调用方只提交 `brief` 和可选 `text`。无 Tool Agent 先按固定 Runtime Skill 编译 Prompt；Registration 验证四段结构、六轴 recipe 和原文保留；Poster Rendering Capability 再生成并持久化图片。公开输出返回图片 URL 和元数据，不返回供应商、模型、Skill 路径、存储配置或原始图片字节。Process 说明见 [`processes/minimal-zine-poster/`](processes/minimal-zine-poster/)，Implementation 见 [`src/processes/poster/registration.ts`](../src/processes/poster/registration.ts)。

`crt-interface-image/v1` 展示参考图流程如何保持同一边界。产品先从独立上传 Interface 获得 `sourceImageId`，再只提交资产标识、调色板和画幅；无 Tool Agent 看不到图片，只编译内部 Prompt 与 recipe；CRT Rendering Capability 负责资产解析、GPT Image 2 编辑、确定性后处理和存储。完整开发契约见 [`processes/crt-interface-image/`](processes/crt-interface-image/)。

### 实现和注册

实施遵循 [`development.md` 的“新增 Business Process”步骤](development.md#新增-business-process)。当前稳定形状是：一个 Registration factory 聚合版本契约与获准依赖，`createProcessExecutor` 的显式 catalog 决定它是否进入生产。每个 production Process 还必须创建与 Process ID 同名的 `docs/processes/<process-id>/` 目录；目录规则和最低内容见 [Business Process 文档目录](processes/README.md)。本文不重复代码步骤。

### 跨 Interface 验证

至少验证以下行为：

- Registration 在启动时拒绝无效 identity、Schema 或重复版本；
- 有效输入只解析一次，并得到符合输出 Schema 的结果；
- 每个失败分支映射为约定的公开错误；
- 只调用该流程获准的 Business Capability 或 Tool，并验证调用次数、稳定幂等键和最终结果来源；
- 真实本地 `POST /execute` 保持精确版本和 HTTP 契约；
- 默认测试不调用模型、真实远端或产生费用的服务。

需要真实 Agent、模型或存储的验证放入独立 smoke，并在运行前说明凭证、费用和外部写入。

## 完成标准

一个流程封装完成时应同时具备：

- 明确且版本化的产品 Interface；
- 代码拥有的 Process Definition 和显式 Process Registration；
- 最小权限的依赖、Agent、Skill 与 Tool 绑定；
- 跨公开 Seam 的确定性测试；
- production catalog 中的显式注册；
- 与 Process ID 同名的独立 `docs/processes/<process-id>/` 文档目录；
- 与当前能力、开发方式和发布范围一致的仓库级文档；
- 对假设、未实现范围和需要真实环境验证事项的清楚说明。

Module invariant 和错误归属见 [`process-runtime-design.md`](process-runtime-design.md)。
