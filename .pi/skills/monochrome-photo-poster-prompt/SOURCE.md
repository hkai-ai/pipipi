# 来源与适配记录

- 来源：https://xhslink.cn/o/4FJeTTu7ve0
- 飞书记录：recvuwnBeIYwXW；需求：黑白蜡笔摄影海报。
- 表格：https://m0e8x072xo3.feishu.cn/wiki/RaztwjZ1oi3ZUJkPZ8ccNTNIn6d?table=tblW30FjWaiQtyD5&view=vewlwzjVhl
- 来源快照日期：2026-09-07；原帖提示词整理，非上游现成 Skill。
- Runtime：`monochrome-photo-poster-prompt@v1`；Process：`monochrome-photo-poster/v1`。
- 适配规则 SHA-256：`dc21fd4205704fe4ff0619db503a6683b7ef70921829496ff37d15c3889949d1`。
- 许可：未声明（NOASSERTION）；开发阶段固定提示词，发布前确认使用与分发许可。

## 审查与适配

采用原帖正文完整提示词；表格中被截断的标题不作为提示词。

图片调用和存储由受控 Capability 拥有；不开放 Shell、MCP、任意文件或网络 Tool。模型编译不接收图片 URL 或用户文字。每次最多一次图片调用；无自动重绘。真实视觉效果以独立验收为准。

回滚随应用恢复上一不可变镜像及 catalog，不按请求更新来源。

## 产品输出修正（2026-09-07）

用户明确要求仅返回原帖对照图中的风格化作品。移除摄影区域、上下分屏与原图拼接；生成完整 1200×1600 风格化成品，原图仅为输入。保留风格规则与来源许可；这是未发布 v1 的需求纠正，旧验收报告保留作历史记录，不代表当前输出。
