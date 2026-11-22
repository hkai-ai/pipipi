# Memebuy Business Process

本页路由 Memebuy 独有的 Business Process。已登记 [`template-from-image/v1`](template-from-image/README.md)：由参考图编译 Gallery v2 可编辑模板草稿，当前对接 Memebuy 素材箱提取 Worker，人工确认后保存草稿；部署与真实页面验收另行完成。

模板编译的模型调用错误复用 [统一诊断](../../process-runtime-design.md#统一诊断与工具选择)，编译、复核与校验活动可以在控制台查看原因；原有合同级诊断和有界修正预算保持不变。 参考图读取归为依赖失败，本地校验的未知程序异常归为内部失败；图片读取公开文案只说明已知失败事实，DNS/Fake-IP 等运维排查不进入公开响应；统一规则见上述诊断文档。

新增 Memebuy 能力时，先固定产品输入、输出、稳定错误和副作用，再按 [`../README.md`](../README.md#新增或修改-process) 建立准确 Process Registration 与同名文档目录。若多个产品可以原样复用同一契约，将该 Process 放入 [`../common/`](../common/)。

Memebuy 的角色表情任务在创建时确定本站或 Pipipi 执行。v12 新写入关闭时，豆包 Q 版沿现有 v3 路径提交。历史 v6、v8 任务分别沿原绑定调用 v2、v3。开启 v12 后，选中 Pipipi 的新任务调用 v4。任务快照的格式版本由 Memebuy 管理，Pipipi 只接收对应 Process 的创作输入。[角色表情包 API](../../api.md#角色表情包)

角色表情按两仓的通用架构约定接入。[与 Memebuy 的职责边界](../../../CONTEXT.md#与-memebuy-的职责边界)

`character-emoji/v4` 单图和漫画分别接收 `mode: "single"` 和 `mode: "comic"`，从每个 `cast[]` 项读取 `character`、`appearance`、`displayName`、`persona` 和 `referenceImageUrl`。输入与回包均按本次阵容绑定身份，取图限定为获准的 Memebuy OSS 角色素材。v2/v3 继续使用原目录与原请求，已有运行按原 runId 恢复。部署同时支持 v2/v3/v4 的 API 和执行 Worker 后，Memebuy 可为新任务选择 v4。两仓使用同一新增角色样例核对参考图顺序与回包身份。[接口合同](../../api.md#角色表情包)

新建双色海报任务在 Memebuy 冻结商品的最终搭配及 Process v2 版本，执行时发送已解析参数。缺少双色快照的历史任务沿用 v1；先部署 Pipipi API、Worker，再部署调用方。[双色海报 v2 接口](../../api.md#双色海报-v2)

历史 Mono Color C 类任务以 `gallery.mono_color` 绑定通用 `mono-color-photo-poster/v1`。五个预设及可编辑项属于业务内容，由 Memebuy 收集并经现有 RemoteRun `/execute` Adapter 提交；Pipipi 固定默认搭配、渲染与输出约束。参考图由 Memebuy 私有资产准备链生成短期可读 URL，结果复用原有审核与转存链路。输入字段以 [API 文档](../../api.md#mono-color-可编辑预设) 为准。

图片转模板按原 Skill 保留逐区文字分类、布局、位置和路由依据，原始观察与选定稳定规则分开保存；共同语义模型生成正式草稿，由独立复核核对。保留完整来源业务规则，槽位取舍直接复用来源原文并复核未入选候选，重复事实由服务端引用投影，内部执行“生成分析与草稿 → 独立看图复核并返回必要补丁 → 程序投影与完整校验”。正常两次模型调用；首轮 JSON 或候选结构不可读可重新编译一次，v2 最终校验发现可修正问题时，可对上次已修订计划追加一次独立看图修正，并重新执行完整校验；独立复核不重写完整候选，也不默认追加模型复核，部分分析采用紧凑行，特征权限及复核报告采用具名对象；九轴权限只要求身份替换槽位提供，其他槽位为 null。证据按来源要求非空且具体，不额外设置四字符下限。修正上下文直接读取引用计划，程序展开后执行完整校验。公开 Gallery v2 草稿合同保持不变；执行失败区分编译、独立复核和本地校验阶段，仅返回安全归类提示。实现与边界见 [图片转模板](template-from-image/README.md)。

旧「方案 → 生图 → 编译」三阶段链路已于 2026-11-17 随 Memebuy「生成方案」入口下线：`template-image-plan/v1`、`template-image-render/v1` 与 `template-from-source/v1,v2,v3` 不再注册，调用按未知 Process 拒绝；在途候选直接放弃，不恢复、不对账、不迁移。新模板任务使用 `template-from-image/v3` → `template-master/v1`。历史 Run Record 与活动归档在保留期内仍可在控制台查看。

模板编译的原始观察、视觉取舍、像素辅助依据与语义投影边界统一见 [来源合同对齐](template-from-image/source-alignment.md)。

Memebuy C 类采用通用 CRT 与照片海报 Process 的背景合同；背景由冻结任务传递，模板输入不能覆盖。合同与发布顺序见 [业务 API](../../api.md#图片背景参数)。

`gallery.memory_checklist` 绑定 `memory-checklist-photo-poster/v1`，`gallery.risograph_album` 绑定 `risograph-album/v1`。两者都只接收一张私有参考图；标题、caption 和唱片文字由 Pipipi 固定，不作为用户槽位。封面导入和上架另行完成。

`template-from-image/v2` 交付带目标归属的运行语义 v3；v1 精确版本保留。字段、复核与发布顺序见 [视觉归属升级](template-from-image/visual-ownership-v3.md)。

模板制作工作台可随同步回执保存脱敏步骤，也可按原运行查询保留期内的 `template-from-image` 步骤记录；见[模板执行步骤](../../api.md#模板执行步骤)。

[`template-master/v1`](template-master/README.md) 由原图与 `template-from-image/v3` 解析结果分档出母版并逐次对照校验，通过后按内容寻址上传到模板公读存储。

`template-from-image/v3` 生成运行语义 V4 的[印花拆解候选](template-from-image/print-design-v4.md)；旧 v1/v2、历史运行和冻结模板不切换。

[`product-remix/v1`](product-remix/README.md) 面向 Memebuy「商品做同款」（`kind = "product.remix"`），推荐经异步 `/process-runs` 提交：以 `sourceImageUrl` 为单层视觉与版式基准，结合可选 `referenceImageUrl` 或 0–9 张有序 `referenceImageUrls` 与 `userText`，在 `budget: { maxAttempts, maxUsd }` 与 `660` 秒硬超时约束下自动分档（`light` / `medium` / `heavy`）、执行多图编辑与 VLM 质检闭环，并在通过后上传至受控对象存储。接口字段与 URL 红线见[商品做同款接口](../../api.md#商品做同款product-remixv1)。
