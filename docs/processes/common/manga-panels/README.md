# `manga-panels/v1` Business Process

将一张照片或插画重绘为完整 1200×1600 黑白漫画分镜页，支持 C「细节三格」与 D「粗笔拼页」。三个画格取自同一参考主体，不生成连续故事或新动作，不保留文字与对话框。

## 契约与实现

公开字段与默认值见 [API 文档](../../../api.md#漫画分镜)。输出 `{ style, image }`；`style` 为 `manga-panels`，图片引用沿用照片海报合同，不公开 Prompt 或供应商。

`src/processes/photo-poster/manga-panels.ts` 解析固定预设并生成服务端约束；无 Tool Agent 使用固定 `manga-panels-prompt@v1` 编译后，Registration 再附同一版式约束。原图 URL 和背景值不进入编译 Agent。图片 Capability 直传原图 URL，一次生图与存储；复用既有超时、取消、幂等和背景合同，不新增生产环境变量。不同预设保留在 accepted input，并形成不同幂等输入和成图指令。

无效字段在模型调用前返回 `INVALID_INPUT`；编译失败为 `AGENT_FAILURE`；图片失败按是否已经提交区分 `DEPENDENCY_FAILURE` 与 `DEPENDENCY_FAILURE_AFTER_COMMIT`。不自动重绘或降级。

## 来源、验证与发布

上游固定版本、MIT 许可、完整目录审查与适配边界见 [SOURCE.md](../../../../.pi/skills/manga-panels-prompt/SOURCE.md)。只发布本地快照，不支持上游角色记忆库、多页或任意风格。Docker 非 root、禁网构建校验完整 Skill catalog；更新固定摘要，回滚恢复应用制品。

确定性测试位于 `test/photo-poster.test.ts`，覆盖两个预设经正式 HTTP 执行、输入拒绝、默认值、编译失败与旧能力移除；完整目录与打包测试另验固定 Skill。真实模型和 OSS 验收见[漫画分镜验收](../../../experiments.md#漫画分镜验收)。人工核对三个画格、跨格身份、手部完整性、墨线及无文字效果，技术字段通过不等于视觉通过。

本次只接入 Pipipi。Memebuy 可将两个模板分别绑定同一 Process 和固定 preset；模板登记、UAT 部署与真实产品验收尚未执行。
