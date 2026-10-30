# 模板编译来源合同对齐

本页记录 `meme-template-json-compiler@v1.13` 的业务规则对应关系。固定来源与字节摘要见 `.pi/skills/meme-template-json-compiler/SOURCE.md`。完整业务文档打包校验与运行行为校验是两件事，不以文档齐全代替合同验收。

## 数据流

批准图片 → 独立分析和原始依据 → 选定稳定规则 → 共同语义模型 → 正式草稿 → 独立复核补丁 → 全部校验。

模型返回的 `draft` 只有 `key`、`title`、`description`、`inputSchema`、`metadata`。`promptTemplate` 与 `runtimeSemantics` 只在 `analysis.semanticModel` 编写，由程序投影到最终草稿。模型不能同时提供第二份草稿语义；程序不从草稿反向填充独立观察。

`fieldEvidence` 保留原始依据，`mediumComposition` 仅保存选定的稳定视觉规则。后者的媒介及数组条目必须保留在正式同名字段。原始观察允许包含没有选为冻结要求的事实，不能强制每条观察逐字进入正式视觉合同。

文字区域沿用来源的角色、语言、原文、布局、位置、语义单元角色、路由依据、动作和编辑价值。`layout`、`position` 为文本，不要求固定六轴、三点几何或固定数量的观察。删除和待辨识区域仍保留观察，待辨识区域阻断最终交付。

模型可见 Schema 同步解释来源脚本的精确填法：`editValue` 按动作映射，`dynamicFactSources` 使用槽位到正式输入路径的映射，文字槽 `openVisualFacts` 包含默认值与全部推荐值原文。字段说明与校验共享同一业务要求，不让模型仅凭字段名猜测。

文字复核的请求级 Schema 将证据分成 `textRegions` 与 `visualContract` 两组，分别限定真实路径。解码只合并原始证据，不代填观察；没有文字时保留普通证据数组。`repairContext.visualFactMismatches` 提供选定事实和正式字段的路径、原值与缺失条目；同义改写仍按来源规则拒绝，由唯一的复核调用同步修正相关字段。

复核证据按分析项、草稿字段和正式视觉合同独立列举，不复用最多 250 项的补丁路径清单。补丁清单可用父容器替换保留边界，证据范围不能因候选变大而截掉视觉合同或八轴依据；请求 Schema 在大候选上也必须可满足。

`slotRecallComplete.evidence` 在传输中使用八轴具名对象，每轴限定对应的实际路径；解码恢复原来的八条证据，不添加观察。适用与不适用的轴均须独立说明，不能只引用父对象来代替逐轴复核。

两次模型调用均保留总览，并可附带一张完整内容观察图。编译模式只去掉近似背景边缘，不切断文字行或组件组；原预处理的固定区域模式不变。总览决定实例、留白与构图，边缘检测可能忽略的淡色细节仍核对总览。该观察附件适配不向正式模板写入裁片，不增加模型请求，也不把某种几何形状设为默认。`layout` 要求具体说明整段排列和各部分相对位置，仍是描述文本而非固定轴对象。

## 规则映射

| 来源规则 | Pi 实现与验证 |
| --- | --- |
| `visualMechanism`、`containers`、`fixedStructure`、`fieldEvidence`、`warnings` | 分析 Schema 保留，不从草稿推断缺失内容 |
| `regionId`、`componentId`、`identityUnitId` | 分别映射为文字 `id`、组件 `id`、`identityId`；`instanceIds` 保留 |
| 文字 role/action/editValue 与语义单元 | `analysis-contract.ts` 和 `quality.ts` 校验；水印只能删除，歧义只能待辨识，同单元路由及角色一致 |
| `translationEquivalences` | 模型提供来源/目标关联；服务端按实际 `exactText` 生成摘要，验证关联、重复、遗漏与过期；摘要不证明翻译正确 |
| `componentCoverage` | 目标范围在 `targetScopes` 声明，生成组件 `targetIds`；组件 `visualFields` 对应覆盖字段，验证全部目标和五类视觉字段 |
| 四类 counts | `analysisCounts` 分别统计身份单元、可见实例、图片输入和控件，在复核上下文提供；不让模型重复计算 |
| `dynamicFactSources` | 与正式槽位一对一对应，指向准确的 `inputSchema.slots.<id>` |
| `completeRedrawByTarget` | 准确覆盖身份目标并逐项确认 |
| `sourceIsolationByInput` | 准确覆盖图片输入并逐项确认；身份继承与模板保留不冲突 |
| `promptCoverage` | 全部槽位与自由编辑文字区域准确覆盖 |
| 默认语言、输入模式、推荐项判断 | 保留结构化结论；语言脚本冲突拒绝，汉字/日语模糊情况留给复核 |
| 文字长度 | 仅 `textRegions.action=open_slot` 对应控件应用快速文字限制，不限制其他槽位轴的描述长度 |
| 标题和简介门禁 | 每项同时保留 passed 与具体 evidence，失败不能仅靠有一段文字通过 |
| 六门禁与三个推荐项代入 | 六门禁保留在候选，推荐项保留同轴/粒度/机制判断；程序插值不代替语义结论 |
| 共同语义投影 | `projection.ts` 从 analysis 生成 Prompt/runtime，保留原始观察；禁止草稿再声明一份运行语义 |
| 自复核摘要 | 候选摘要按对象键排序计算，避免 Schema 字段顺序改变使相同候选误判失效；复核不代填通过结论 |

## 保留的服务边界

- 原 Skill 的同轮 self-review 由已有第二个无 Tool 会话承担，保留十九项检查、输入计划摘要和有界补丁；正常两次调用，首轮不可读取时最多一次重新编译。这是运行适配，不是来源指定的模型调用次数。
- 使用现有模板模型、思考配置、单图 Process、公开 Gallery JSON、两次图片人工审批与费用边界。
- 已批准图片的身份与上传由 `template-from-source` 服务控制；通用 `template-from-image/v1` 仍接受 PNG/JPEG/WebP HTTPS 图片。分析 sidecar 不由模型重复声明服务端图片身份。
- `imageSize` 在通用输入上沿用公开合同的最接近画幅选择。预处理输出的固定合法尺寸精确匹配；不借此次内部对齐破坏已有任意尺寸输入。
- key 注册表、落库、revision 文件和工作台读回归调用方。原 Python、Shell 与网络权限不交给 Agent。
- `note` 表示按同一批准图重新编译；当前公开接口没有原 `compile_json_revision` 的旧 JSON、摘要和预声明 scope，不能宣称是原 Skill 的局部返修。批量交付与工作台操作不在此单图服务中。

## 验证

- `test/template-source-contract.test.ts` 使用来源匿名夹具检查语义投影、原始依据和四类数量，并覆盖文字路由、翻译摘要、输入隔离、完整重绘、语言/模式/推荐项门禁和证据缺失。
- 原匿名夹具复制到 `test/fixtures/template-source-contract.json`；来源为固定目录的 `examples/integration-input.json`，不包含真实用户素材或凭证。
- 既有 HTTP、Agent、补丁、紧凑传输、Skill 摘要与生产镜像测试继续覆盖端到端程序路径。
- 这些确定性检查只证明数据与规则一致。视觉验收必须另行保存实际模型观察和生成图片；不得人工加入弧度后宣称自动识别通过。

## 观察到规则的对账边界

原始视觉依据通过内部 `visualSelections` 逐项记录保留或舍弃理由，并引用正式约束；独立复核分别检查图像观察、取舍和执行句，不能只核对已有引用。该对账不预设形状，也不要求所有观察成为冻结规则；原始观察遗漏与舍弃合理性仍依赖看图判断。

`fieldEvidence.visualContract` 保留原始观察，`visualSelections` 对每个 evidenceIndex 记录唯一 retain/omit 决定和 reason；保留项通过 factRefs 引用正式字段，medium 使用 null 索引，其余使用数组索引。新增观察没有取舍、保留项无有效引用、舍弃项同时声明冻结时拒绝。结构错误在原有独立复核预算内修正，不自动追加调用。

这是宿主对来源取舍过程的显式记录，不是来源原字段。十九项报告中的 `visualContractRespectsInputs` 使用 observations、selections、visualContract 三组证据；复核先从图中找遗漏，再检查舍弃依据与合法替换可能发生的漂移，不能只复述已选事实。取舍摘要只传给本次复核，不进入日志或正式 Gallery JSON。

`test/template-visual-selection.test.ts` 覆盖观察遗漏、合法舍弃、不同排列、失效引用、三组复核证据和有界补丁。引用存在不证明语义相同，也无法发现模型完全没观察到的事实，必须单独运行真实视觉验收。

### v1.13：提供可核对的像素依据

原规范要求依据图像记录轮廓与画面组织；宿主新增 `contours.ts` 辅助观察，原八份文档与业务判断不变。仅在边缘背景足够一致时，按背景差异分离横向内容带，提供十二段前景上下缘位置，以及每四段的上下缘均值，便于比较不同尺度的位置变化。它不识别文字、不拟合弧形、不计算字体基线，也不生成模板约束。测量阈值用于抑制噪声，低对比细节可能遗漏，仍须核对原图；复杂背景或无法可靠分带时不提供。

测量基于实际传入的解码附件，同次提供给编译与复核；不改变附件、公开草稿或两次调用预算。首轮响应先填写内部 `imageObservation` 原始观察记录，再逐区分析、取舍与编译；第二轮仍是独立看图复核，不增加第三次观察请求。原始记录不进入公开草稿，不由服务端回填，不等于审核通过。它作为内部计划的一部分参与输入摘要；已存在字段的顺序调整不改变摘要算法。独立复核仍负责判断测量所支持的整体关系是否影响玩法，并保留到正式规则；不能把程序测量通过当作视觉验收。

`test/template-contours.test.ts` 覆盖平直、中部较高、局部交错、不同前背景颜色、复杂背景、无内容与取消；`test/template-compact.test.ts` 校验请求顺序和计划内容、摘要不变。真实模型与成图的实验记录另行保留。

### 视觉验收边界

像素测量与引用校验不能保证模型观察及成图一致性。实际验收应同时保留成功、偏差及失败样本，分别核验原图观察、正式视觉约束和实际成图；不将人工追加提示后的结果算作自动识别通过。单张成功不代表任意素材或每次生成都能一致复现。
