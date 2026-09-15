# Memebuy Business Process

本页路由 Memebuy 独有的 Business Process。已登记 [`template-from-image/v1`](template-from-image/README.md)：由参考图编译 Gallery v2 可编辑模板草稿，当前对接 Memebuy 素材箱提取 Worker，人工确认后保存草稿；部署与真实页面验收另行完成。

新增 Memebuy 能力时，先固定产品输入、输出、稳定错误和副作用，再按 [`../README.md`](../README.md#新增或修改-process) 建立准确 Process Registration 与同名文档目录。若多个产品可以原样复用同一契约，将该 Process 放入 [`../common/`](../common/)。

Memebuy 的 Mono Color C 类模板以 `gallery.mono_color` 绑定通用 `mono-color-photo-poster/v1`。五个预设及可编辑项属于业务内容，由 Memebuy 收集并经现有 RemoteRun `/execute` Adapter 提交；Pipipi 固定默认搭配、渲染与输出约束。参考图由 Memebuy 私有资产准备链生成短期可读 URL，结果复用原有审核与转存链路。输入字段以 [API 文档](../../api.md#mono-color-可编辑预设) 为准。

图片转模板保留完整来源业务规则，槽位取舍直接复用来源原文并复核未入选候选，重复事实由服务端引用投影，内部执行“生成分析与草稿 → 独立看图复核并返回必要补丁 → 程序投影与完整校验”。正常两次模型调用，仅首轮 JSON 或候选结构无法读取时允许一次重新编译，最多三次；独立复核不重写完整候选，也不默认追加模型复核，部分分析采用紧凑行，特征权限及复核报告采用具名对象；九轴权限只要求身份替换槽位提供，其他槽位为 null。证据按来源要求非空且具体，不额外设置四字符下限。修正上下文直接读取引用计划，程序展开后执行完整校验。公开 Gallery v2 草稿合同保持不变；执行失败区分编译、独立复核和本地校验阶段，仅返回安全归类提示。实现与边界见 [图片转模板](template-from-image/README.md)。

图片预处理新增 [方案规划](template-image-plan/README.md)、[审核后生图](template-image-render/README.md)、[审核后上传与编译](template-from-source/README.md) 三个固定入口。沿用来源强制替换设计，两次人工确认均在 Memebuy 页面，旧 template-from-image 直接编译行为保留。

图片替换方案在原 240 秒预算内允许一次字段补丁修正，完整复验后才交给人工确认；失败阶段和固定规则可诊断。详见 [方案校验与修正](template-image-plan/README.md)。
