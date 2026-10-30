# 摄影抽象记忆海报

本页说明 `travel-abstraction-photo-poster/v1` 的行为与接入边界，供 Memebuy 照片模板及复用该契约的产品使用。HTTP 输入输出、错误与调用示例统一见 [API 文档](../../../api.md#照片海报)。

## 执行与依赖

读取固定 `travel-abstraction-photo-poster-prompt@v1`，无 Tool Agent 编译内部英文规则；Registration 校验后调用共享 Photo Poster Rendering Capability。内部 `POST /photo-posters` 使用 FAL GPT Image 2 编辑并保存 PNG，配置 OSS 时返回持久化 URL。每请求处理一张原图，最多一次图片调用，以 runId 作为幂等键；不自动重绘。

公网 HTTPS 原图 URL 原样交给 FAL，服务端不下载或拼接原图。输出为一张完整的 1200×1600 风格化 PNG，整张画布都属于插画或版画，不附摄影区域、上下分屏或对照图。旅行抽象保留编号、日期与英文短语，由代码绘制在抽象成品上。

## 来源与适配

来源、固定 revision、哈希、许可和适配差异见 [SOURCE.md](../../../../.pi/skills/travel-abstraction-photo-poster-prompt/SOURCE.md)。本地 Runtime 不运行第三方脚本，也不下载或更新远程 Skill。

用户已确认取得修改和服务端集成授权；书面授权与再分发范围待补充。当前为受限服务端适配版，省略上游参考图库、跨请求编号和自动视觉重绘，不声称运行原版 Codex Skill 或 Python finalizer。

用户确认仅交付风格化作品，当前未发布 v1 已按此修正；原帖的对照布局只用于理解来源。

## 验证与限制

实现：[Registration](../../../../src/processes/photo-poster/registration.ts)、[图片服务](../../../../src/business-api/photo-poster.ts)。确定性验证：[契约与 HTTP 测试](../../../../test/photo-poster.test.ts)。真实验证通过 `npm run accept:photo-poster-business`，说明见 [实验](../../../experiments.md#照片海报业务验收)。

图片生成与 OSS 有费用和外部写入。调用方需确认原图使用权与资产保留策略。规则编译失败为 AGENT_FAILURE；图片调用已发出且失败或状态不确定时保守返回 DEPENDENCY_FAILURE_AFTER_COMMIT，不能自动重试。抽象质量、背景均匀性和文字之外新增内容仍需人工视觉检查。

## 2026-09-07 首轮实测（历史对照图）

原图 960×587 RGB 像素完全保留，成品960×1350；下部偏具象、背景有渐变及侧边色差，严格抽象风格验收未通过。技术链路一次 POST /execute、一次 FAL GPT Image 2 编辑、一次 OSS 存储与结果回读通过。详见 [本次验收记录](../../../experiments.md#2026-09-07-照片海报实测)。

可选背景参数及兼容行为见 [图片背景参数](../../../api.md#图片背景参数)。背景参数直接传给模型，不追加或改写提示词；透明输出的最终 PNG 校验真实透明像素，失败不自动重绘。
