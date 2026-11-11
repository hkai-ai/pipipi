/** 固定 v3 目标事实的作者和复核规则，只适配字段归属，不猜测图中事实。 */
export const ownershipInstructions = [
    "本 Process v2 使用 runtimeSemantics.version=3；inputSchema.version 仍为 2。固定来源 Skill 的业务观察、槽位决策和完整复核继续适用；其中 v2 运行语义的字段落点由以下 v3 合同替代，不在全局重复目标事实。",
    "先观察原图，再判断每条视觉事实的归属。描述具体目标的身份、种类、轮廓、五官、身体形态与自身配色写入该 targetInstances 的 appearance 数组；姿势、朝向、动作、相对位置写入同一目标的 pose 数组。仅记录看得见的事实，不足以确认的归属必须在 warnings 和独立复核标出并阻断结果，不推测填充。",
    "pose 用无身份修饰的谓语，如‘右手举起勺子，站在画面左侧’，不能夹带原物种、身体形状或自身配色。role/region 只作中性目标定位，不把外观写入 pose 或全局事实。一个句子混有两类事实时无损拆分；不得删减、概括或按字数截断正式视觉事实。",
    "visualContract 仅保留不依附具体目标身份的媒介、画风、全局配色、构图和跨对象关系。目标外观不能同时出现在 visualContract、pose 或前台固定文案。替换实际激活时 appearance 会移除，pose 会以新主体为主语保留；没有替换时两类均保留。服装仍按 clothingOwnership 决定：模板固定服装的可见规则作为全局要求保留，不能随 appearance 被删除。",
    "mediumComposition 仅记录全局稳定规则并与 visualContract 对账；原始 fieldEvidence 保留包括目标外观在内的观察。同一原始观察只作一个取舍决定，优先在一项 factRefs 中列全引用；分组 retain 仅允许互不重复的事实引用，不得混入 omit。visualSelections 的 retain 可引用全局 {field,index} 或目标 {targetId,field:'appearance'|'pose',index}；每条目标事实必须有原始观察及 retain 引用，不能将其误标 omit，也不能由正式字段反向补造观察。",
    'backendFactRefs 与九轴 runtimeFactRef 同样支持目标引用；全局媒介用 {field:"medium",index:null} 引用，其他全局或目标数组必须用非负索引；spatialRelations 紧凑行第三项可为旧 relations 索引，或明确目标事实引用，单目标动作定位引用 pose，跨对象关系仍引用全局 relations。后端事实引用不改变事实归属，不得把 appearance 当成替换后仍强制保留的规则。',
    "固定文字 textRegions.action=preserve 时，exactText 必须逐字出现在正式视觉约束中，不能只写‘标题’或‘保留文字’。即使先修正了 targetScopes 等引用，也要继续核对全部文字事实和视觉取舍；修正需同步来源观察对应的正式约束及引用，不能仅把复核结论改为通过。",
    "repairContext.unreferencedTargetFacts 逐项列出缺失保留引用的事实与 requiredRef；须先核对原始观察，再修正对应 visualSelections，不得从正式事实反向伪造观察。没有依据的事实应纠正其来源与投影，不能直接标记通过。独立复核须对全局事实和每个目标的 appearance/pose 分别看图核对，检查事实丢失、重复、错归、原身份泄漏和替换后姿势继承；用全部推荐项代入验证，未解决歧义标记 passed=false，不修改为通过。",
] as const;
