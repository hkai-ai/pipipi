# 来源与适配记录

- 来源：https://github.com/Evianis/travel-photo-abstraction
- 飞书记录：recvuwnBeIGjaN；需求：摄影抽象记忆海报。
- 表格：https://m0e8x072xo3.feishu.cn/wiki/RaztwjZ1oi3ZUJkPZ8ccNTNIn6d?table=tblW30FjWaiQtyD5&view=vewlwzjVhl
- 来源快照日期：2026-09-07；固定 commit：`96e387635edf05bc7e798428a5db11dbf48f46c1`。
- Runtime：`travel-abstraction-photo-poster-prompt@v1`；Process：`travel-abstraction-photo-poster/v1`。
- 适配规则 SHA-256：`5cc7d1f2364178b94c85c008e7d6315efd2a97e2a2ab5b5a091790b3a1f19528`。
- 许可：保留上游受限 LICENSE。用户在 2026-09-07 本对话确认已取得允许修改并集成到服务端的额外授权；具体书面授权及发布、再分发范围待补充，本次不发布。

## 审查与适配

已审阅 SKILL、分析方法、风格指南、参考索引、运行记录格式；静态检查四个 Python 脚本的本地读写、合成、验证、子进程和失败删除行为。未执行脚本、未下载参考图库。受限 Agent 编译规则，图片模型分析唯一原图；按用户修正的产品要求省略原图拼接；Node/Sharp 仅在独立抽象作品上绘制档案字样。省略 19 张参考图库、自动视觉判定/重绘和跨请求编号；phrase 由调用方提供，日期缺省使用服务端 UTC 创建日期。

图片调用和存储由受控 Capability 拥有；不开放 Shell、MCP、任意文件或网络 Tool。模型编译不接收图片 URL 或用户文字。每次最多一次图片调用；无自动重绘。真实视觉效果以独立验收为准。

回滚随应用恢复上一不可变镜像及 catalog，不按请求更新来源。

## 上游文件摘要

| 文件 | SHA-256 |
| --- | --- |
| travel-photo-abstraction/SKILL.md | 97c5658fe93791f615ce85945fb83ed78820db664669c1d3f361c20e7ba4515b |

## 产品输出修正（2026-09-07）

用户明确要求仅返回原帖对照图中的风格化作品。移除摄影区域、上下分屏与原图拼接；生成完整 1200×1600 风格化成品，原图仅为输入。保留风格规则与来源许可；这是未发布 v1 的需求纠正，旧验收报告保留作历史记录，不代表当前输出。
