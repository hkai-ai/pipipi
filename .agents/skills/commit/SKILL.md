---
name: commit
description: "安全提交当前对话 Session 的改动，并为每个需要发布的 commit 创建仓库原生 release metadata。Use only when the user explicitly asks to commit current work, 提交一下, 提交这批改动, prepare a commit, or create a Git commit in any language or ecosystem."
---

# Commit

把明确的提交请求视为本地 commit 授权，不重复确认。默认只提交当前 Session；用户
明确指定时才扩大范围。

## 范围

以本次对话的工具记录、实际 patch 和直接生成文件识别 Session 改动，而不是把所有
dirty 文件都算进来。

- 排除用户原有改动、其他 Session、其他 Agent 和无关 staged 文件。
- 同一文件混有多方改动时，只暂存可验证属于当前 Session 的 hunk。
- 范围外 staged 路径可被可靠保留时使用 path-limited commit，并在提交后复核。
- 无法拆分、发现疑似凭据或不能保留原暂存状态时停止询问；不回显凭据或擅自 unstage。

## Release metadata

读取仓库指令、manifest、版本配置和 CI，沿用 Changesets、towncrier、release note
fragments 或其他既有机制；仓库没有片段机制时不引入新工具。

- 每个需要发布的 commit 都必须把对应片段和代码放进同一个 commit。
- 按独立用户结果拆分片段；一个 commit 可有多个片段，一个片段可覆盖多个发布单元。
- 为本次 commit 创建独立片段；重复执行时更新本 Session 尚未提交的片段，不重复创建。
- 根据仓库策略确定版本影响；使用 SemVer 时为 `major`、`minor` 或 `patch`。
- 纯测试、文档、CI 或无发布影响的内部改动可为 `none`，但必须在执行摘要中说明原因。
- 发布文本语言：用户指定 → 仓库指令 → 现有元数据 → 当前对话语言。命令、标识符、
  package 名和版本号保持原样。

## 执行

1. 读取 commit 规范、hooks、状态和相关 diff，确定 Session 路径、发布意图和片段内容。
2. 生成符合仓库语言与格式的 commit message；无约定时使用 Conventional Commits。
3. 执行前简要列出将提交和保留的路径、release metadata 动作及 commit message；
   范围清楚时直接继续。
4. 写入片段，按精确路径或 hunk 暂存，复核 staged diff，运行快速相关校验后提交。
5. 不绕过 hooks，不使用 broad staging。返回 commit hash、片段、校验结果和剩余改动。

仅在所有权不明、hunk 无法拆分、疑似凭据、扩大到 Session 外，或出现 breaking/major
发布意图时确认。不要 push、tag、publish、deploy 或发送外部通知。
