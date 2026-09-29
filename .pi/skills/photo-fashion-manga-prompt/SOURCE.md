# 来源与适配记录

- 来源：用户在当前会话提供的日式手绘时装漫画完整提示词，以及按该提示词整理的本地 `photo-fashion-manga` Skill。
- 本地来源：`C:/Users/admin/.codex/skills/photo-fashion-manga/SKILL.md`，SHA-256 `57e512adb525c872142af466da67c25612e56d57256dea6881dc298a6a38b75a`。该路径只记录来源，运行时不读取。
- 许可：`NOASSERTION`；用户授权本项目接入与真实测试，未提供另行再分发许可证。
- 已审查来源目录：`SKILL.md` 与 `agents/openai.yaml`，无脚本、引用资源或 MCP 依赖。UI 元数据不进入运行包。
- 固定身份：`photo-fashion-manga-prompt@v1`，绑定 `photo-fashion-manga/v1`。运行正文 SHA-256 由 `src/processes/photo-poster/skills.ts` 固定。
- 适配：原文同时写了 3:4 与方形画布，按明确的 3:4 要求固定 1200×1600；仅接收一张真人照片，风格由固定正文提供，不增加第二张风格图。无 Tool Agent 只编译规则，照片及用户文案只交给共享图片 Capability。
- 文案：默认主标题、引题、小注由服务端 Schema 拥有，空字符串代表删除；编译 Agent 不生成具体文案。保留身份、姿态、服装类别、可见身体、红蓝配色与手刻字要求。
- 视觉修订：按用户对首轮成图的反馈，明确无衬线手刻粗字、轻微前倾与不齐基线、宽松衣服大轮廓、头肩两侧小字和紧凑字图关系；将过强的印色缺口禁令收敛为可读性约束，允许克制纸纹与不齐边缘。服务端在编译前及生图前重申同一固定设计约束，不增加看图 Agent 或图片调用。
- 副作用：单次图片编辑与配置存储由既有 FAL、OSS Adapter 执行，Skill 无文件、Shell 或网络权限。
- 回滚：恢复上一应用制品及 production catalog；不运行时更新来源或单独替换已固定正文。
