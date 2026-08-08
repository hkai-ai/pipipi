---
name: release
description: "发现并编排仓库原生发布机制，以生态中立方式检查发布工具链就绪状态，汇总 release metadata，准备版本、CHANGELOG 和测试计划，并在明确授权后执行外部发布与 Webhook 通知。Use when the user asks to inspect release readiness, prepare a version, publish an already reviewed release, configure release Webhooks, or send release notifications in any language or ecosystem."
---

# Release

默认执行本地 `prepare`。外部 `publish` 必须基于已展示且未变化的动作清单。

## 发现发布模型

读取仓库指令、版本文件、发布配置、脚本、CI、当前状态、tags 和 remotes，先识别
workspace root、生态、发布模型及仓库认可的执行入口，再确定版本策略、发布单元、目标
版本、release metadata、CHANGELOG 生成方式，以及 commit、tag、publish、push、
deploy 和通知分别由本地还是自动化负责。

使用仓库原生工具，不因本 Skill 引入新机制。检测到 Changesets 时读取
[Changesets 适配器](references/changesets.md)，并使用仓库安装的 CLI。
需要 Webhook 通知时读取 [Webhook 通知](references/webhook.md)，优先使用仓库原生
通知入口；没有入口时仅在用户选择配置后使用本 Skill 的初始化与发送脚本。

执行入口可以是仓库包装器、task/script、生态工具、固定版本 CLI 或 CI，也可以对不
需要命令的发布模型记为 `none`。`pnpm`、`uv`、`poetry`、`cargo`、`bundle exec`、
`./gradlew`、Make 和自定义脚本都只是可能入口；不得把任一生态的 manifest、lockfile、
package manager 或 CLI 当作所有仓库的通用前提。

输出语言：用户指定 → 仓库指令 → 现有 CHANGELOG/发布文档 → 当前对话语言。

## 发布工具就绪门禁

生成 release plan 前，根据该发布模型实际要求的配置、metadata、版本声明、脚本、CI、
依赖锁定和执行入口，将仓库归类为：

1. `ready`：所有必需组件可用；若仓库固定工具版本，实际版本与固定值一致。不适用的
   package manager、lockfile 或 CLI 记为 `none`，不构成失败。
2. `configured-but-unavailable`：已发现发布配置、metadata、版本声明、脚本或 CI 引用，
   但该模型的某个必需组件缺失、无效或不可执行。停止并报告；不得假装发布机制不存在，
   也不得降级为手工计划。
3. `absent`：没有发现仓库原生发布机制。只根据 Git 证据生成只读计划并停止；不得
   修改版本、CHANGELOG 或 release metadata，也不得执行 publish。

报告以下信息：

- workspace root、检测到的生态、发布模型及证据。
- 本地与自动化 ownership，以及仓库认可的执行入口。
- dependency/package manager、锁定或版本固定方式；不适用时明确写 `none`。
- 必需、已发现、缺失或不可执行的组件。
- 修复类别：`install-locked-dependencies`、`repair-configuration` 或
  `initialize-release-tooling`。
- 仓库是否已有独立的 doctor/setup/bootstrap 命令或文档；有则给出精确入口，没有则
  明确写 `none`。

不得用未受仓库约束的全局工具或临时下载版本，替代发布模型要求的本地、包装或固定
版本工具。若该生态本来就以系统工具为标准入口，则核对仓库或 CI 对其版本的约束，
不能仅因它不是 Node 风格的本地依赖而判为不可用。

## 发布工具安装与初始化交接

本 Skill 不安装、升级、初始化或配置发布工具，普通 `prepare`、`publish` 以及附带的
“顺便装一下”都不例外。

状态不是 `ready` 时，只输出诊断和交接信息并停止。仓库已有独立命令或文档时，展示其
精确命令或路径，但不在 release 流程中执行；不存在时明确说明尚无恢复入口，不自行
选择 Changesets、Hatch 或其他机制，也不生成可能下载未锁定工具的临时命令。

安装或初始化属于单独任务。用户未指定发布模型时，先完成工具选择和授权；外部流程修复
完成后，再从“发现发布模型”和就绪门禁重新开始。

此边界针对发布工具链。Webhook 是可选的独立外部动作：缺少 Webhook 不降低发布工具
就绪状态；用户要求通知但没有配置时，必须让用户选择“配置 Webhook”或“跳过本次通知”。
只有前者授权运行 `scripts/init_webhook.py`，且初始化完成后重新发现配置。URL 只能来自
环境变量或 secret manager，不得写入配置、日志或动作清单。

## Prepare

仅当状态为 `ready` 时，用户说“准备发布”才授权以下本地步骤，不需要确认：

1. 记录 `HEAD`、工作区和目标版本；生成器可能覆盖无关修改时停止。
2. 在消费任何片段前，用仓库原生命令导出 release plan。若模型本身没有 plan 命令，
   从其权威 metadata 和版本文件合成计划；该分支不能用于掩盖预期命令不可执行。空计划
   时区分无待发布内容与已 prepare。
3. 把用户版本当作预期结果并与计算值核对，不修改工具内部状态强行凑版本。
4. 调用 `$maintain-test-plan`，传入完整计划、候选版本、Git ref 和已有测试证据。
5. 运行仓库原生 version/CHANGELOG 步骤，再用已保存的 plan 和最终 version/build
   幂等刷新测试计划。
6. 验证版本、依赖、CHANGELOG、片段消费、测试文档和计划外文件。

相同目标已存在未提交的 prepare 产物时只重新验证。完成后展示 release plan、完整
本地 diff、校验结果，以及下一步实际需要的外部动作；不 commit、tag、push、publish、
deploy 或通知。

## Publish

若尚未展示精确动作，先列出本次实际存在的 release commit、tag、registry publish、
push refs/触发的 CI、deploy environment、Webhook 通知，以及发布后测试文档写回的责任方，
然后等待“确认发布”。用户对未变化清单说“确认发布”后直接执行，不再要求第二次
`ok`。

Webhook 清单必须包含 provider、配置来源、URL 环境变量名、触发时机、稳定事件 ID 输入、
失败策略和执行入口，不显示 secret URL。把通知放在核心发布动作成功之后；通知失败时
不得把已成功的 registry/tag/deploy 描述为失败，也不得自动重试。`best-effort` 明确报告
后可结束，`blocking` 保持编排未完成并等待新的重试授权。

执行前重新运行发布工具就绪门禁，并重新核对 `HEAD`、版本、测试门禁、目标与自动化
ownership；状态不是 `ready` 或任何关键项变化时停止并返回新清单。按顺序执行，每步
成功后再继续；失败时停止并列出已完成、未完成及安全恢复方式。可能重复发布的步骤
必须重新授权后才能重试。

需要 release commit 时调用 `$commit` 并限定为本次生成路径；版本与 CHANGELOG 产物
不再创建新的发布片段。发布成功后调用 `$maintain-test-plan` 写入真实证据：正式版
冻结，候选版只更新构建历史。若文档发生变化，只执行动作清单中已确认的 commit/push；
否则明确报告待写回状态。
