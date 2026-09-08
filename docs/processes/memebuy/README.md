# Memebuy Business Process

本页路由 Memebuy 独有的 Business Process。当前 production catalog 尚未登记明确归属于 Memebuy 的 Process，因此本目录不把通用图片或文本流程猜测性地归入 Memebuy。

新增 Memebuy 能力时，先固定产品输入、输出、稳定错误和副作用，再按 [`../README.md`](../README.md#新增或修改-process) 建立准确 Process Registration 与同名文档目录。若多个产品可以原样复用同一契约，将该 Process 放入 [`../common/`](../common/)。

Memebuy 的 Mono Color C 类模板以 `gallery.mono_color` 绑定通用 `mono-color-photo-poster/v1`。五个预设及可编辑项属于业务内容，由 Memebuy 收集并经现有 RemoteRun `/execute` Adapter 提交；Pipipi 固定默认搭配、渲染与输出约束。参考图由 Memebuy 私有资产准备链生成短期可读 URL，结果复用原有审核与转存链路。输入字段以 [API 文档](../../api.md#mono-color-可编辑预设) 为准。
