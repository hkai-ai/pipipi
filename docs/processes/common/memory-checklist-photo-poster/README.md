# `memory-checklist-photo-poster/v1` Business Process

本文说明把一张公网参考照片生成上下分屏记忆清单海报的业务契约。HTTP 输入输出、错误和调用示例统一见 [API 文档](../../../api.md#照片海报)。

## 执行与依赖

服务端固定绑定 `memory-checklist-photo-poster-prompt@v1`，使用无 Tool Agent 编译图片指令，再调用共享 Photo Poster Rendering Capability。内部 `POST /photo-posters` 使用部署配置的图片供应商和存储；每次请求最多一次图片调用，以 `runId` 作为下游幂等键。

调用方只提交一张公网 HTTPS `sourceImageUrl`，可选提交 `background`。标题、caption 和九个记忆单元由服务端按照片内容固定，不接收 `text`、Prompt、模型或 Skill。输出是一张 1200×1600 PNG：上半保留参考照片的身份、姿态与光影，下半是同一张照片里可见细节构成的松散 3×3 蜡笔涂鸦。

## 来源与适配

来源、许可和适配差异见 [Runtime Skill 来源记录](../../../../.pi/skills/memory-checklist-photo-poster-prompt/SOURCE.md)。运行时只加载固定 `SKILL.md`，不执行来源脚本，也不向 Agent 开放 Tool。

## 验证与发布边界

实现复用 [`src/processes/photo-poster/`](../../../../src/processes/photo-poster/)，Registration 由 [`src/processes/catalog.ts`](../../../../src/processes/catalog.ts) 显式注册。Memebuy 以 `gallery.memory_checklist` 绑定本 Process，用户只上传一张照片。本次完成代码注册；封面导入、上架和付费视觉验收另行完成。
