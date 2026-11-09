# 来源与适配记录

- 来源：飞书「模板需求表」2026-11-09 记录「复古音乐专辑封面模板」，提交人潘超泽（Peter）。记录地址 `https://m0e8x072xo3.feishu.cn/wiki/RaztwjZ1oi3ZUJkPZ8ccNTNIn6d?table=tblW30FjWaiQtyD5&view=vewlwzjVhl`。
- 许可：`NOASSERTION`。需求表授权接入；未另附可再分发许可证。
- 固定身份：`risograph-album-prompt@v1`，绑定 `risograph-album/v1`。运行正文 SHA-256 由 `src/processes/photo-poster/skills.ts` 固定。
- 适配：合同是 1:1 方形封面，不是其他照片海报的 1200×1600。人物半身侧脸固定在左三分之一，右侧大面积亮黄；深蓝网点人物对亮黄网点背景。固定文字为红色手写 i'm ok 和黑色小号 HAPPY EVERYDAY，不接受调用方改字。服务端在编译后重申画幅、构图和这两句文字。
- 副作用：单次图片编辑与配置存储由既有 FAL、OSS Adapter 执行。Skill 无文件、Shell 或网络权限。
- 回滚：恢复上一应用制品及 production catalog。
