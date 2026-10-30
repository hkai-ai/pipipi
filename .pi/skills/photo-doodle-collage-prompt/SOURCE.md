# 来源与适配记录

- 来源类型：本地个人 Skill 快照
- 来源路径：`C:/Users/admin/.codex/skills/photo-doodle-collage`
- 来源许可：`NOASSERTION`；仅按本地实现与测试授权使用，发布前需确认正式授权范围
- 运行 Skill：`photo-doodle-collage-prompt@v1`
- Process：`photo-doodle-collage/v1`
- 适配：运行时只加载本文件旁的 `SKILL.md`；移除 Codex 内置 imagegen 调用说明，图片由 Pipipi 已注册的 Photo Poster Rendering Capability 负责；固定为单张连续摄影剪贴成品，不向请求方开放 Skill、模型、Tool、供应商或提示词字段。
- 回滚：恢复上一个 Pipipi 应用制品，移除本快照及对应 `photo-doodle-collage/v1` Registration。
