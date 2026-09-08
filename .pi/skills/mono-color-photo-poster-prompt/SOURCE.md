# 来源与适配记录

- 来源：https://github.com/yanliudesign/mono-color-skill
- 飞书记录：recvuwmSUahNmJ；需求：双色油墨图文海报。
- 表格：https://m0e8x072xo3.feishu.cn/wiki/RaztwjZ1oi3ZUJkPZ8ccNTNIn6d?table=tblW30FjWaiQtyD5&view=vewlwzjVhl
- 来源快照日期：2026-09-07；固定 commit：`c8ff70597ddedcd65f21a0b528f6a70c35690b0a`。
- Runtime：`mono-color-photo-poster-prompt@v1`；Process：`mono-color-photo-poster/v1`。
- 适配规则 SHA-256：`4efba752b8e0574d3a8196727667b5db63f569b641f3a4746d9863b477da9a91`。
- 许可：指令和软件 MIT，保留 LICENSE；示例与第三方图片有独立限制，均未复制。

## 审查与适配

已审阅完整 Skill、六个 JSON 目录和资产许可，静态检查脚本的 JSON/图片读取、SVG 输出、rsvg-convert 子进程。未运行上游脚本，不打包示例、参考图片或脚本。固定为参考图双色复古网点子集，目录内联到单文件 Skill；移除桌面文件写入、主题生图、自由画幅和自动重绘。本接入不声称取得小红书作者私有魔改 Prompt。

图片调用和存储由受控 Capability 拥有；不开放 Shell、MCP、任意文件或网络 Tool。模型编译不接收图片 URL 或用户文字。每次最多一次图片调用；无自动重绘。真实视觉效果以独立验收为准。

回滚随应用恢复上一不可变镜像及 catalog，不按请求更新来源。

## 上游文件摘要

| 文件 | SHA-256 |
| --- | --- |
| SKILL.md | 8274bc1f30a92a9dc715c03c3fb9aeaa060fb5a12fd58dfe8d977ae98a26bd76 |
| design-system/colors.json | e299d6b4a2ec36e2e59b7095b85bae5f13609f505d21c9a83561088f7c446b48 |
| design-system/compositions.json | 8faec6d102a6dcf15a465123f00265609afe271dd2998baa0d56f0fb39105703 |
| design-system/typography.json | b20f558444aab2c93b6339b76aa3178ae9e04e25eed1059cd2db8044733db26f |
| design-system/rhythm.json | 02c8c4ca0bba218feeca7311b35b61362972bded129f050b288a384d61c0c920 |
| design-system/imperfections.json | e281a1c7fb183af973179a7588df5745527a231462681797850227e791372715 |
| design-system/carriers.json | 32ad6bd5917c8d5ad4b0c8f78006848f941489649824f0857a7a94685914a8d7 |
