# Webhook 通知

仅在发布需要 Webhook 通知时读取。优先沿用仓库已有通知脚本或 CI；只有仓库没有原生
入口、且用户选择使用本 Skill 的通用配置时，才使用本目录下的脚本。

## 配置发现与初始化

检查仓库通知脚本、CI secret 引用和 `.release-webhook.json`。不得读取、输出或写入
Webhook URL；只报告 provider、配置来源、URL 环境变量名和失败策略。

未发现配置时，询问用户选择“配置 Webhook”或“跳过本次通知”。选择跳过时把通知从
动作清单中移除；选择配置时将初始化作为独立的本地任务，先收集 provider 和失败策略，
再运行：

```bash
python3 <release-skill-dir>/scripts/init_webhook.py \
  --repo <workspace-root> \
  --provider <generic|slack|discord|feishu|dingtalk> \
  --failure-policy <best-effort|blocking> \
  --non-interactive
```

脚本默认生成 `.release-webhook.json`，其中只有非敏感设置；URL 由
`RELEASE_WEBHOOK_URL` 环境变量或用户指定的变量提供。交互式终端也可不带参数运行脚本，
由它引导选择。初始化后重新执行配置发现，不因已有配置推断 secret 一定可用。

## 动作清单

把 Webhook 作为独立外部动作，列出触发时机、provider、事件 ID 输入、配置路径、URL
环境变量名、失败策略和执行入口，但不显示 URL。默认只在 registry、tag、push、Release
和 deploy 等核心发布动作全部成功后发送 `published`；若仓库原生流程定义其他事件，以
仓库约定为准。

使用 `best-effort` 时，通知失败不改变已经成功的发布状态，但必须显式报告。使用
`blocking` 时，通知失败会让整个编排保持未完成；它仍不能撤销已经发生的发布动作。
两种策略都不得自动重试，因为接收端可能没有按事件 ID 去重。

## 发送与验证

确认动作清单后，优先运行仓库原生入口。使用 Skill 配置时运行：

```bash
python3 <release-skill-dir>/scripts/send_webhook.py \
  --config <workspace-root>/.release-webhook.json \
  --repository <repository> \
  --version <version> \
  --status published \
  --tag <tag> \
  --release-url <url> \
  --summary <short-summary>
```

发送脚本支持 generic、Slack、Discord、飞书和钉钉；默认只允许 HTTPS。它输出 provider、
稳定事件 ID 和 HTTP 状态，不输出 URL 或响应正文。发送前可用 `--dry-run` 检查 payload；
dry run 不是交付证据。失败时记录核心发布是否已完成、通知状态和安全重试命令，等待新的
明确授权后再重试。
