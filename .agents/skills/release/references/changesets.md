# Changesets 适配器

仅在仓库使用 Changesets 时读取。以仓库锁定的 CLI 版本、配置和 CI 为准，不固定
package manager。这是 Changesets 专用的 Node 工具链要求；没有 Changesets 证据的
Python、Rust、Ruby、JVM 或其他仓库不得套用本文件的 manifest、lockfile 和 CLI 条件。

## 就绪检查

- 从 Node workspace root、`packageManager`、manifest 和 lockfile 确定 repo runner；
  npm、pnpm、Yarn、Bun 或其他入口以仓库证据为准，冲突时停止并报告。
- 把 `.changeset/`、`@changesets/cli` 声明、包装脚本或 CI 引用中的任一项视为已配置
  证据，不能因另一个组件缺失而将仓库归类为 `absent`。
- 检查 `.changeset/config.json` 存在且可解析。
- 检查 `@changesets/cli` 同时存在于 workspace manifest 和对应 lockfile importer，且
  声明与锁定版本一致。
- 检查仓库脚本或本地 CLI 可执行，读取并记录实际版本。包装脚本缺失不单独构成阻塞，
  前提是 repo runner 能安全执行已锁定的本地 CLI。
- 优先使用仓库包装脚本，其次使用 package manager 执行本地依赖。只解析仓库本地
  binary；禁止使用全局 `changeset`，也禁止使用 `npx`、`pnpm dlx` 或其他会临时下载
  未锁定版本的方式。无法排除自动下载时视为不可用。
- 依赖已在 manifest 和 lockfile 中锁定但 `node_modules` 缺失时，归类为
  `configured-but-unavailable`，修复类别记为 `install-locked-dependencies`。报告仓库
  已有的独立安装命令或文档；本 Skill 不执行安装，也不重新添加或升级依赖。
- 配置存在但依赖未声明、manifest 与 lockfile 不一致或本地 CLI 仍不可执行时停止，
  分别报告 `repair-configuration` 或 `initialize-release-tooling`；不得降级为手工发布
  计划。
- 只能从全局找到 CLI 时归类为 `configured-but-unavailable`。

## 发现

- 读取 `.changeset/config.json`、可选 `pre.json`、manifests 和发布脚本。
- 核对 `commit`、`fixed`、`linked`、`ignore`、private packages、changelog 和内部
  依赖配置。
- 展开包装脚本，区分本地 version 产物与 publish、tag、push 等外部动作。
- Changeset 和 CHANGELOG 可使用中文；frontmatter package 名与版本号保持原样。

若 `commit` 配置会让 `version` 自动提交且 prepare 无法安全抑制，停止并报告，不临时
修改已跟踪配置。

## Prepare

在临时路径导出计划，并让 `status` 紧邻且早于 `version`：

```bash
PLAN_DIR=$(mktemp -d)
<repo-runner> changeset status --output "$PLAN_DIR/plan.json"
```

检查退出码与 JSON；计划只用于本轮交接，不依赖其跨版本格式稳定性。把 releases、
依赖传播、fixed/linked 结果和所有 Changeset 正文交给 `$maintain-test-plan`。

用户给出的版本是断言，不是 `changeset version` 参数。prerelease 按仓库锁定版本的
状态机执行 `pre enter <tag>` / `pre exit`，随后仍需 `version`；不要手改状态凑版本。

计划、目标版本和测试文档一致后运行 `<repo-runner> changeset version`，验证 manifests、
依赖、CHANGELOG、片段删除及 `pre.json`。重复 prepare 时先识别已有版本 diff。

## Publish

- `changeset publish` 会发布 registry package，并默认创建本地 Git tags。
- 只需要 tags 时使用锁定版本提供的 `git-tag` 等价命令，不与 publish 重复执行。
- Git push、GitHub Release、应用部署和通知是独立外部动作。
- Changesets Action 可能拥有 version PR、publish、tags 或 GitHub Release；将其标记为
  automation-owned，不在本地重复。

参考：[CLI](https://changesets.dev/guide/cli)、
[Prereleases](https://changesets.dev/guide/prereleases)、
[Changesets Action](https://github.com/changesets/action)。
