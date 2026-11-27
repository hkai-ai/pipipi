# 来源与运行适配

来源为同组织仓库 `hkai-ai/memebuy_monorepo` 的 Memebuy 应用。准确修订与逐文件 SHA-256 在 `source-manifest.json`；纯 schema/检查器与经确定性章节裁剪的运行规则由 `tools/build-template-v4-contract.ts` 固定生成。`v3` 从同一已审查来源剔除研发期反推试验复盘、下游印前/工厂验收、CLI 批量导入及旧 v1～v3 `visualContract` 章节，只保留六层印花拆解、数据格式与 v4 运行语义/输入绑定规则。无第三方图像或执行脚本进入快照。

审查范围包括 `print-same-style` 的入口及方法正本、作者合同、纯 schema 与检查器；原开发 Skill 的模型命令、文件写入、网络、凭证、导入和报告脚本不进入生产 Agent。只安装声明性规则，禁止 Tool、Shell、文件和网络访问；受控图片由宿主提供。格式与非空码点取值的适配不改变检查规则。

模型默认使用 `gpt-6.1-terra` 单次看图拆解：首轮同时完成结构校验、Memebuy 拆解词表检查与绑定一致性校验，零错直接返回；结构或业务合同报错时最多触发一次同缓存前缀的有界修正，不额外开启独立看图复核会话。通过结构检查不证明视觉或实际印刷质量。候选观察不进入公开模板、日志或 Run Record。bbox 仍须人工叠图核对；缺少的像素统计保持未知。

回退新请求可恢复 Process v2。v1/v2 的旧 Skill、Schema 和恢复路径不改；已保存 V4 模板仍需支持 V4 的消费者。更新来源时先审查、更新 manifest，再重建快照和固定摘要；`--check` 逐文件核验，不按请求下载来源。

## v4（2026-11-23）

只改作者规则：新拆解的 `designSpec.defaults` 保留原图内容（原图主体、逐字原文、原图配色），不再做作者默认迁移；可替换性仍由输入槽与 `followsSubject` 表达。原因：母版同时是模板封面与生成参考图，默认值改动原图时，母版会只改字不改图或无法通过对照（UAT 实例：DOGTOR 被迁移为橘猫与 CATCTOR）。

来源仍固定在 Memebuy `4838accfee73821c038689ba1bfa60eaa2c57324`，仅在 `print-design-preparation.md` 与 `agent-template-json-runtime-contract.md` 两份文件上叠加与 Memebuy `2fe81071c`（feat/print-design-keep-original）等价的默认值规则；生成器前言同步改写同一句规则。Memebuy 自该修订以来的 schema 与检查器演进未纳入本版，`gallery.schema.json` 与 v3 逐字节相同。`docs/gallery/template-import/schema.json` 在 Memebuy `e59e3e90ef` 后改为按需生成，本版沿用上述修订中的已审查文件。

## v5（2026-11-27）

全面对齐 Memebuy `6696111e7951f453a570f34e7f1d7a3a6b571fc9` 的正交轴与多品类解耦口径：

- 印花处理改以正交轴原生表达：`whole.background`（`none` / `backdrop` / `load_bearing`）、`whole.boundary`（`complete` / `cut`）、`whole.container`（`none` / `own` / `library`）、`whole.edge`（`hard` / `soft_fur` / `fade`）、`printFit.garmentTone`、`printFit.subjectSwap` 及配饰 `wornOnSubject`。
- 区分满版原画与设计贴片：原图无真实外框的整幅场景/海报/满铺花纹记为 `load_bearing + container.kind = none`（不透明满版原画，严禁虚构 `edge` 收形元素），服饰收边交由下游品类程序处理；纯色/纸色衬底记为 `backdrop + none` 并记录 `prePress.paperColor` / `paperColorHex`；仅原图自带真实外框时记 `container.kind = own` 并写 `edge`。
- 新增 1 对 N 同主体重复布局 `subject.occurrences`（`count`、`arrangement`、`scaleNote`、`variants`），禁止将重复主体小像写入 `accent` 或 `defaults.accentSources`。
- 禁止执行描述与 `composition.density` 混入审阅备注/草稿词（如“原图未见”“候选新增”“需人工确认”“待人工叠图核对”）或以“未知”开头。
- `gallery.schema.json` 改由 Memebuy `pnpm docs:template-schema` 生成的 `tmp/generated-docs/gallery-template/schema.json` 裁剪并锁定 `runtimeSemantics` v4 分支生成，同步纳入全部新字段。
