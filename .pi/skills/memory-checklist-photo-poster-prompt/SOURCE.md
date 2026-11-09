# 来源与适配记录

- 来源：飞书「模板需求表」2026-10-15 记录「3:4上下分屏记忆清单海报模板」，提交人盛常升，参考小红书 @爱吃蜜枣粽。记录地址 `https://m0e8x072xo3.feishu.cn/wiki/RaztwjZ1oi3ZUJkPZ8ccNTNIn6d?table=tblW30FjWaiQtyD5&view=vewlwzjVhl`。
- 许可：`NOASSERTION`。需求表授权接入；未另附可再分发许可证。
- 固定身份：`memory-checklist-photo-poster-prompt@v1`，绑定 `memory-checklist-photo-poster/v1`。运行正文 SHA-256 由 `src/processes/photo-poster/skills.ts` 固定。
- 适配：合同要求 3:4、上下严格各占一半。上半保留原片身份、姿态与光影；下半把照片中可见的 9 个单元做成松散 3×3 蜡笔涂鸦，并写手写英文标题和一行小 caption。服务端在编译后重申画幅和禁止发明照片中没有的物件。无 Tool Agent 只编译规则，照片不进入文本 Agent。
- 副作用：单次图片编辑与配置存储由既有 FAL、OSS Adapter 执行。Skill 无文件、Shell 或网络权限。
- 回滚：恢复上一应用制品及 production catalog。
