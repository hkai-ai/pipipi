# Issue Tracker

本仓库的规格和工作项使用 `hkai-ai/pipipi` GitHub Issues。自动化工具在仓库 clone 内通过 `gh` CLI 操作，并从 `origin` 推断仓库。

## 约定

- 创建：`gh issue create --title "..." --body "..."`。
- 读取：`gh issue view <number> --comments`，同时读取 labels。
- 列表：`gh issue list --state open --json number,title,body,labels,comments`，按任务需要增加 label 或 state filter。
- 评论：`gh issue comment <number> --body "..."`。
- 标签：`gh issue edit <number> --add-label "..."` 或 `--remove-label "..."`。
- 关闭：`gh issue close <number> --comment "..."`。

当 Skill 要求“发布到 Issue Tracker”时，创建 GitHub Issue。需要读取相关 ticket 时，读取 Issue 正文、评论和 labels。

## Pull Request

Pull Request 不作为 triage 请求入口。GitHub Issue 与 Pull Request 共享编号空间；遇到不明确的 `#<number>` 时，先检查 Pull Request，再检查 Issue。
