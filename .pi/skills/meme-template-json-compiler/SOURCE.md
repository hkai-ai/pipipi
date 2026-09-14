# 来源与适配

- 来源：用户指定的 `E:/Deployment/meme-template-production/skills/meme-template-json-compiler`。
- 固定 Git commit：`a52c87668aa6cb7907306864e85ab861978b2f43`；接入时源目录无未提交修改。
- `source-manifest.json` 记录原目录 26 个文件的工作区字节摘要；原文件可能含 CRLF。
- `gallery.schema.json` 来自 `references/contracts/gallery-template.schema.json`，仅统一为 LF，SHA-256 为 `38166c6b4939b11a1a5934fc1342baf35dba833dcda40a6179e5cde858369efb`。
- 上游未发现许可证声明，记录为 `NOASSERTION`。本次由用户授权在 Pipipi 本地适配与测试；不代表取得上游开源许可证或批准对外发布。

## Runtime 边界

v1.7 保留组件、空间关系、覆盖审查、六门禁、推荐项与标签的紧凑行；将易错的特征权限恢复为 {owner,basis,evidence,runtimeFactRef} 具名对象，owner 对应来源 authority，复核报告改为 {passed,evidence:[{path,observation}]}。仅 replace_identity 槽位要求完整九轴，其他槽位明确为 null。证据按来源要求非空且具体，取消适配层额外的四字符下限，模型证据仍最多 96 字符；正式 visualContract 不受此上限约束。编译、复核输入及补丁共用同一套权限字段，不自动填充判断或证据。

修正上下文直接读取引用计划，即使关系或特征事实引用失效也保留其他槽位约束，避免把计划误按完整候选解析后丢弃上下文。仍使用独立复核、输入摘要、有界补丁和最终完整校验，调用预算及公开 Gallery 合同不变。

当前 Runtime Skill 为 `v1.7`：开发期完整嵌入原目录的 product-model、approved-image-analysis、slot-decision-cases、authoring-fields、tags、visual-contract、gallery-v2、返修与读回校验八份业务文档，不再用约 3300 字符摘要替代。仅换行统一为 LF，规则正文保留原文。原始 SKILL.md 的阶段顺序由 Runtime 入口说明和代码编排承接。

沿用 v1.3 的内部引用计划：正式 visualContract 是唯一事实文本来源，空间关系用 relationIndex，后端事实和特征执行规则用 {field,index} 引用已有条目。服务端生成 semanticModel、mediumComposition、backendOnlyFacts、runtimeFact、slotEvidence.defaultValue 和 substitutions.prompt，再执行既有完整候选校验与独立复核报告校验。槽位选择、事实本身、特征权限、推荐项语义证据仍由模型判断，不能用引用有效冒充图像正确。补丁修改计划后重新投影；引用错误定位具体字段并计入原有一次修正预算，不拼接冲突句子。修正上下文单独列出缺失关系与槽位特征约束，仅传给模型，不写入日志或产品响应。

目标到组件的对应关系仅在 targetScopes 声明。服务端生成组件 targetIds，并按正式 binding 生成槽位 componentIds，保留重复身份及多目标各自的范围；不存在、重复或遗漏的目标/组件引用会被拒绝。正式目标的 role/region 和视觉规则是否真正描述同一范围仍需模型复核。

v1.2 的入口槽位取舍直接提取 authoring-fields 原文，保留 2–4 个高价值轴的优先要求及单槽例外，移除适配层偏向少槽的概括。独立复核同时审查未入选候选与固定理由；槽位修正同步所有字段及开放属性约束。主视觉配色、标志物、关系文字和嵌套内容仍按原案例判断，不给每张图强制增加槽位。输入图片能力回到原文的素材与目标映射判断；模型、思考级别、公开合同与调用预算不变。

重建命令：`node --import tsx tools/build-template-skill.ts <已审查来源目录>`。命令先验证 manifest 的全部 26 个文件，再生成本地 SKILL.md；来源变化会停止，不能绕过重新审查。生成后更新 skills.ts 的版本和摘要，并运行加载回归测试。该命令不在请求路径执行。

同一命令追加 `--check` 只读核验来源与生成结果。回归测试独立从打包正文还原来源换行并逐文件核对 manifest 摘要，不依赖开发者本地来源路径；禁止手改打包正文而不更新生成器。

### 业务规则对应检查

| 来源要求 | 当前对应与限制 |
| --- | --- |
| 八轴召回、六门禁、单槽例外 | 原文完整保留，入口取舍自动提取；编译与独立复核检查未入选控制，不以装饰类别决定固定 |
| Prompt、槽位和运行语义表达同一玩法 | Schema 与字段对应校验保留；新增槽位的修正同时提供完整目标 Schema，避免编造操作名 |
| 默认值、推荐值与开放事实不被锁回 | 三个推荐项实际代入与语义模型一致性做确定性检查；同义描述和图像事实仍需视觉复核 |
| 媒介、构图、关系、色光完整 | 五字段规则全文保留，选定事实和目标引用做对应校验；不把 Prompt 长短作为完整度指标 |
| 素材到身份或内容的映射 | 按原文判断文字与图片能力；合法 target、binding 和输入归属受固定 Gallery Schema 约束 |

以上对齐业务规范，不承诺不同模型或不同运行生成逐字相同的模板。文件交付、注册表和工作台等宿主差异见下文。

原 Python 的文件交付、注册表、工作台读回、历史 revision scope 与翻译等价摘要协议没有移植。当前无 Tool 服务使用结构化 analysis 保存玩法、组件、身份、文字路由、八轴覆盖、候选六门禁、九轴特征权限、推荐项真实代入、发现文案与视觉事实；semanticModel 与正式字段必须逐值一致。容器和嵌套关系通过组件与空间关系表达，计数由绑定结构确定，不让模型重复造一套计数。完整 Python 分析对象的形状未原样复制，不能宣称协议完全等价。

v1.5 恢复来源强调的独立轻量复核：首轮仅生成 analysis、draft，下一次独立视觉 Session 重新看图，原样回传 reviewedPlanSha256 输入摘要，返回必要 changes 补丁与针对最终候选的十九项 review。报告必须有真实 JSON Pointer 和具体观察，slotRecallComplete 逐一覆盖八轴；程序验证输入摘要、合并补丁、投影候选并绑定最终摘要，再执行全部规则。正常两次调用，不默认追加复核；仅首轮 JSON 或候选结构无法读取时额外允许一次重新编译，最多三次。不同于 v1.4 的同响应自评，也不恢复 v1.3 的四次调用编排；独立会话有助于发现遗漏，但不保证视觉判断永远正确。defaultLanguageReview 的自然、简洁和修饰最少判断由 defaultsNaturalAndIdentitySpecific 承接，不要求增加 Schema 外字段。模型仍可能判断错误；记录存在与字段对应不证明图片事实真实，也不等于实际生图验收。编译与独立复核统一使用 medium 思考；各阶段保持 JSON 输出模式，关闭 SDK 内层重试和自动压缩，调用上限由 Registration 拥有。`TEMPLATE_MODEL` 只覆盖本 Process，其他 Process 保持原设置。

对结构完整的候选，修正 Adapter 要求字段替换补丁，并提供与首轮相同的完整 draft 和 analysis Schema，新增槽位时也有合法目标与 binding 的字段约束；由服务端保留其余内容，避免整份重写引入漂移。没有明确问题时返回空补丁，但仍须提交独立复核报告；结构无法读取时才重新生成完整候选。补丁不是公开输入，也不允许访问外部资源；最终结果仍通过全部校验。

服务端通过受控下载器取得公网 HTTPS 单图，限制地址、下载大小、像素、格式和重定向，再把解码后的 PNG 附件交给视觉模型。接受 PNG/JPEG/WebP；不要求原流程的 approved-upload OSS envelope。Agent 无文件、Shell、代码执行或网络 Tool；只读取发布时固定的本地 Skill。原目录内脚本不复制、不执行。

Ajv 校验固定 Draft 2020-12 Gallery Schema；业务校验额外检查槽位、占位符、默认值隔离、目标引用和身份归属。状态、图片地址、尺寸等由服务端注入；key 是玩法建议名，尚未经过 Memebuy 注册表去重。只返回 `PROMPT` / `DRAFT`，不生图、不入库、不发布。

Skill 与 Schema 均锁定 LF 和 SHA-256；修改规则必须同步摘要、测试与版本决策。回滚时撤回该 Process 的 catalog 登记及对应快照，已返回草稿不自动撤销。
