# `risograph-album/v1` Business Process

本文说明把一张公网人物照片生成复古音乐专辑封面的业务契约。HTTP 输入输出、错误和调用示例统一见 [API 文档](../../../api.md#照片海报)。

## 执行与依赖

服务端固定绑定 `risograph-album-prompt@v1`，使用无 Tool Agent 编译图片指令，再调用共享 Photo Poster Rendering Capability。内部 `POST /photo-posters` 使用部署配置的图片供应商和存储；每次请求最多一次图片调用，以 `runId` 作为下游幂等键。

调用方只提交一张公网 HTTPS `sourceImageUrl`，可选提交 `background`。封面文字固定为红色手写 `i'm ok` 和黑色小号 `HAPPY EVERYDAY`，不接收 `text` 或其他文案。输出是一张 1200×1200 PNG：人物半身侧脸位于左侧三分之一，右侧为大面积亮黄网点，人物为深蓝网点。

## 来源与适配

来源、许可和适配差异见 [Runtime Skill 来源记录](../../../../.pi/skills/risograph-album-prompt/SOURCE.md)。运行时只加载固定 `SKILL.md`，不执行来源脚本，也不向 Agent 开放 Tool。

## 验证与发布边界

实现复用 [`src/processes/photo-poster/`](../../../../src/processes/photo-poster/)，Registration 由 [`src/processes/catalog.ts`](../../../../src/processes/catalog.ts) 显式注册。Memebuy 以 `gallery.risograph_album` 绑定本 Process，用户只上传一张人物照片。本次完成代码注册；封面导入、上架和付费视觉验收另行完成。2026-11-09 的低质量预览没有达到左侧三分之一侧脸构图，不能当作验收通过。
