# `photo-doodle-collage/v1` Business Process

本文说明把一张公网参考照片生成完整摄影剪贴与互动黑线小人海报的业务契约。HTTP 输入输出、错误和调用示例统一见 [API 文档](../../../api.md#照片海报)。

## 执行与依赖

服务端固定绑定 `photo-doodle-collage-prompt@v1`，使用无 Tool Agent 编译图片指令，再调用共享 Photo Poster Rendering Capability。内部 `POST /photo-posters` 使用部署配置的图片供应商和存储；每次请求最多一次图片调用，以 `runId` 作为下游幂等键。

调用方提交一张公网 HTTPS `sourceImageUrl`，可选提交要印刷的 `text`。服务端不接收 Skill、模型、供应商、提示词或运行配置。输出是一张完整的 1200×1600 PNG：连续浅色纸张背景、真实摄影剪贴主体、少量与主体互动的黑线小人和克制英文手写文案；不输出上下拼接、原图对照或可编辑图层。

## 来源与适配

来源、哈希、许可和适配差异见 [Runtime Skill 来源记录](../../../../.pi/skills/photo-doodle-collage-prompt/SOURCE.md)。来源许可为 `NOASSERTION`，正式发布前需确认授权范围。运行时只加载固定 `SKILL.md`，不执行来源脚本、不下载远程 Skill，也不向 Agent 开放 Tool。

## 验证与发布边界

实现复用 [`src/processes/photo-poster/`](../../../../src/processes/photo-poster/)，Registration 由 [`src/processes/catalog.ts`](../../../../src/processes/catalog.ts) 显式注册；确定性验证见 [`test/photo-poster.test.ts`](../../../../test/photo-poster.test.ts)。本次只完成本地注册与契约验证，尚未部署到线上，也未运行付费图片 smoke。真实验收须使用有授权的公网照片并按照片海报实验记录结果。
