# Character Emoji

`character-emoji/v2` 把 Memebuy AI 角色表情包小工具接入 Pipipi。调用方提交角色名单、外观版本和创意；服务端默认提供本地短素材卡供 Agent 改编或原创，仅必要时联网搜集素材，再生成经过 Schema 与角色身份校验的单图方案或多格漫画分镜，最后用角色目录中的固定参考图生成 PNG。

## 角色背景与创作

`src/processes/character-emoji/character-personas.ts` 原样迁入 Memebuy 同名文件的10个角色背景。来源为 Memebuy 的 `docs/gallery/ai-character-persona-research.md`，研究 JSON、来源卡片仍用于研究维护，不整份进入运行时。单图与漫画的构思输入按角色 ID 注入 creativeBrief；仅按情境启发行为，用户指定剧情优先，外观由参考图决定。不将角色背景当成本次搜索证据，不把背景全文拼入生图提示词。

提交前在同次构思中默看画面：暂时遮住解释性台词，检查关键行为或可辨认痕迹是否可见，再逐人核对手脚占用、支撑及道具接触。冲突时安置道具、删减次要动作，或在用户要求的格数内拆开先后瞬间；跨格结果由已展示的行动承接。不新增字段、独立复核或调用轮次。这是模型创作指导，不能保证语义正确。

## 本地梗素材

`memes.ts` 维护首批22张短卡，版本为 `2026-10-20.v1`，来源与核验限制见[研究记录](../../../research/model-meme-library-2026-10-20.md)。`materials.ts` 按角色、名称别名与题材做本地候选排序：明确点名优先，其余先覆盖角色，再补候选，最多6张角色卡；公共梗只在命中别名或题材时补充，最多2张。此步骤不增加 Tool 或模型调用，不把候选排序当成语义判断。

Agent 只收到卡片 ID、名称、短摘要与适用范围；来源链接和维护信息留在服务端。角色背景 creativeBrief 继续独立提供。Agent 可选用、组合或放弃卡片，内部 `adaptation.entryIds` 最多引用两个本次实际提供的本地或联网材料 ID，原创用空数组。公开方案、请求参数及图片提示词不增加素材字段，动作与可见后果仍只写在 scene。

历史事件、个体体验、产品活动与社区二创在 scope 中区别，不自动升级成当前产品事实。用户剧情优先；没有合适卡片时可原创，素材少不意味着必须联网。搜索实际失败时沿用直接原创策略，entryIds 为空。库更新随代码发布，维护时同步版本与研究依据；本轮不增加自动采集或数据库。

## 按需搜索

默认按已给素材创作或原创。服务端 `search-policy.ts` 在打开会话前保守识别 idea 的检索要求：明确的搜索、查资料或核实指令，或者近期新闻、热梗、公告等时效要求，才允许开放 `search_memes`。普通角色互动、修桌子、做蛋糕、露营等剧情没有工具；“今天去露营”不会仅因“今天”开放搜索。明确禁止搜索优先于允许条件，引号内台词不作为检索指令。

未满足条件时，会话不注册搜索 Tool，请求载荷移除 tools 与 tool_choice，Tool 执行入口也拒绝未获准调用。开放工具后 Agent 仍可直接创作；最多搜索一次，失败直接原创。不增加模型分类请求或公开配置字段。规则偏向少搜，不是完整的自然语言语义识别；含糊的外部事实需求可能不开启搜索，需要在 idea 中明确表达检索要求。未搜索时 adaptation.entryIds 只允许本次本地 ID 或空数组，观测记录 search/skipped、耗时0；原业务校验保持执行。

## 执行与模型

流程使用专用 Pi Session，默认无 Tool，满足服务端搜索条件时仅暴露 `search_memes`。固定 Runtime Skill 分为公共 `character-emoji-planner@v18`、单图 `character-emoji-single@v4` 与漫画 `character-emoji-comic@v6`；每次仅加载公共和当前模式。模式由已校验的业务输入决定，调用方不能选择 Skill。

`tools/build-character-emoji-skill.ts` 从 `scene-prompt.ts` 的公共、单图和漫画规则生成完整快照和摘要，所有快照纳入 production catalog、镜像与 LF 校验。修改后运行生成器，再用 `--check` 核对。当前规则基于移植的 Memebuy 业务合同精简，不宣称逐字对齐。失败样本保留在验收材料中，不逐个追加到通用规则。

| 阶段 | 固定模型 | 权限 |
| --- | --- | --- |
| 联网检索 | `deepseek-v4-flash-260425` | Responses 原生 `web_search` |
| 构思与方案修正 | `deepseek-v4.1-flash` | 构思只有 `search_memes`，修复关闭 Tool |
| 图片 | Memene `gpt-image-2.5-flare`，Magikaru `gpt-image-2.5` 备用 | 固定图片 Capability |

搜索读取 `CHARACTER_EMOJI_BASE_URL`（默认 `https://llmapi.memene.cn/openai/v1`）与 `CHARACTER_EMOJI_API_KEY`。构思和修正可独立设置 `CHARACTER_EMOJI_PLANNER_BASE_URL`、`CHARACTER_EMOJI_PLANNER_API_KEY`，未设置时复用搜索的地址和凭证；模型身份仍分别固定。Pi ModelRuntime 与设置都在内存中，不继承全局 Pi 配置。构思模型通过自定义 Tool 获得资料，不要求原生联网。DeepSeek 4.1 Flash 使用 Memene 的 `deepseek-v4.1-flash` 路由、Responses 与函数调用。当前网关拒绝 `json_schema`，因此明确使用 `json_object` 并随构思及修正请求传入同一候选 Schema；返回后执行原有完整结构、来源、台词及冻结校验，JSON格式、可定位结构和配字错误共用一次原会话修正机会。搜梗模型保持 `deepseek-v4-flash-260425`。网关部署映射使用官方动态别名 `deepseek-flash`，不能将本地路由名视为永久锁定1017权重。

搜梗 Tool 固定原始 cast 与 idea，只接受不超过200字的 focus。仅必要时发起一轮联合检索，最多两个方向，返回最多两条不同候选及同次原生引用摘要，由 Agent 按用户要表达的动机、行为与反差选材；只共享主题词不足以采用，都不适用时原创；不能将技术背景或用户创意改写成社区实例。原生请求使用 `tool_choice:required`，确认搜索调用全部完成、正文完整且无拒绝后才返回。搜索尝试结束后关闭 Tool。模型只整理 kind、summary、sourceUrl，适配器逐条接收并兼容旧字段；缺摘要或引用只降低可信程度，完整搜索正文格式不符时作为未核验资料交给 Agent。调用失败、拒绝、不完整搜索或搜索子预算超时直接原创，不再搜索；用户取消和整体截止仍停止。交给 Agent 的每条摘要最多800字符，引用片段最多1200字符，不重复完全相同的摘要与引用，不传URL；状态说明最多400字符。全文绑定及来源ID保持在请求内，裁剪不改变来源资格。搜索提示词要求关键行为在前，不追加摘要模型调用。

Registration 保持120秒共享截止时间、至多一次搜索 Tool、最多三次 Agent 请求（默认首轮出稿；必要时先调用 Tool 再出稿，另允许至多一次JSON格式、结构或台词修正），搜索独立上限30秒，并取剩余时间三分之二与该上限的较小值，为构思和修正留出时间；搜索输出上限4096 tokens，其余8192。首轮判断与构思共用 low 推理预算，修正为 none，DeepSeek 搜索为 low；自动重试和自动压缩关闭。Agent 在同一会话中完成搜索、构思及提交前自检，不再启动独立复核会话。来源错误、角色不匹配或角色/分格容器不合法时拒绝。JSON无法读取、可定位的画面字段类型、枚举及长度错误与配字错误共用一次原会话修正机会。JSON无法读取时要求仅修复格式并重交完整对象；程序无法对不可解析内容逐字段冻结，重交后执行完整校验。可读取候选只修改报错字段，其他字段逐值冻结。修正后失败即停止，不再修正或重新搜索。不搜索时正常仅一次主 Agent 请求，修正时两次；搜索时正常两次主 Agent 请求加一次搜索模型请求，修正时主 Agent 最多三次。不增加独立的搜索判断模型调用。

搜索 Adapter 异常保留固定类别、阶段、HTTP 状态（收到响应时）和阶段耗时；整次执行失败时的生产诊断附 runId，不包含模型正文、来源、URL、凭证或原始异常。类别区分配置、网络、超时、取消、HTTP 错误、拒绝、不完整响应、不完整搜索与响应格式异常。HTTP 429 与 5xx 通过状态码区分；构思模型报错记录 model_error；JSON语法、结构、来源绑定、业务校验、越界修正分别记录 invalid_json、invalid_schema、invalid_source、business_validation、repair_changed_content。结构与业务错误只保留最多12项固定规则码及净化字段路径，未知键替换为星号，不记录原始异常或字段值。诊断失败不改变业务结果。搜索 Adapter 的异常由 Agent 转为原创材料状态，不记为整次 Process 失败；生产通过 character_emoji_observation 记录 runId、搜索结果、净化原因码、可用的HTTP状态和耗时，保留成功兜底时的失败原因。构思完成或失败记录主模型调用数、修正尝试次数及总耗时（包含搜索），成功时区分来源材料改编与原创；这些值只用于观测，不代表语义验收。构思模型失败仍停止。资料不足时原创；未核验资料可作灵感，但不能声称是已证实的社区经历。不自动重试或补查。

单图通过角色 ID 匹配身份与参考图，允许 actors 数组与 cast 顺序不同；仍要求身份集合一致、无重复、无遗漏。输入参考图顺序保持由 cast 决定。单图只传本次适用的配字指令；缺省 `captionSetting` 时保留旧版意图解释。动作、位置、道具状态及可见笑点由每格唯一的 scene 拥有，图片编译器只输出一次。文字与风格规则如下。

台词、身份与品牌标识放入原有字段并准确绘制，其他情节需要的短字、数字或符号可随 scene 描述；绘图模型可少量补充非关键场景文字。不再禁止“你”“我”“只改一行”，也不再将所有文字限制在登记字段内。`none` 只关闭主台词；idea 明确禁止任何文字时优先于配字设置，同时关闭标识和辅助文字。其他情况下 custom 原样使用自定义台词，none 关闭主台词；auto 或缺省时结合 idea，明确不要对白则不配台词，仍允许必要场景文字。构思、校验和生图共用同一有效文字策略。单图默认白底动漫贴纸，用户要求或情节需要的风格、背景写入 scene。

本轮注册 character-emoji/v2，输入和图片链路保持原行为，公开 plan 改为单一场景合同。production catalog 只注册 v2；旧 v1 候选与固定布局投影仅留作本地回放对照，不参与 v2 的自由分格，不做版本回退或旧字段填充。调用方须显式切换版本并读取 scene。方案持久化、跨请求会话恢复、Memebuy 任务历史及计费对齐不在范围内。正式图片入口尚未读取已保存回执恢复 pending；已保存回执可供运维对账，不代表正式入口已实现恢复。

图片主用 Memebuy 同款 Memene `gpt-image-2.5-flare`，参考 Memebuy 的 OpenAI Images Edit 调用，以 multipart 的 `image[]` 按原顺序上传多张参考图，提交一次；内部图片服务独立读取 `CHARACTER_EMOJI_IMAGE_API_KEY` 和可选 `CHARACTER_EMOJI_IMAGE_BASE_URL`（默认 `https://llmapi.memene.cn/openai/v1`）。Pipipi 校验角色素材白名单及1至5张数量，参考图并行读入内存后上传，不落临时文件。素材请求不携带网关凭证、不跟随重定向；整批读取最多15秒并计入主用及整体预算，每张最多20 MiB，按实际字节识别 PNG/JPEG/WebP；读取失败进入原有备用策略。已有字节输入复用同一文件表单。Magikaru 仍接收原始参考图 URL。质量沿用 `CRT_IMAGE_QUALITY`，默认 low。备用使用 `MAGIKARU_API_KEY` 和可选 `MAGIKARU_BASE_URL` 的 `gpt-image-2.5` External Job。只配置 Magikaru 时保留旧部署行为；两个密钥均缺失时不可生图。图片凭证只属于内部图片服务，不复制进 API/Worker 的 agent_keys；现有 Compose 从共享环境文件加载。

主用调用发生任何错误时立即尝试一次 Magikaru，包括所有 HTTP 错误、网络中断、主用超时、响应解析及图片格式校验失败。用户取消或整体截止仍停止；未配置备用时保留主用错误。两路共享最多300秒等待上限，并服从调用方截止；配置备用时主用最多180秒，为备用保留剩余预算，仅配置主用时仍为300秒。正常只调用主用，备用失败不重投。`character_emoji_image_attempts` 观测仅保留幂等关联、模型、结果分类、HTTP 状态与耗时，主备失败分别保留，观测失败不影响生成。提交前仍记录 pending，Magikaru 受理后保存 `jobId`、`deadlineAt` 与幂等键，只轮询原 Job。PNG 经内部图片服务与对象存储交付；取消等待不会取消上游生成；本流程按用户要求对主用提交未知也切换一次备用，因此可能产生两路生成与费用。此策略只覆盖同一次执行的主用到备用，不自动重投任一渠道或重启已保存 pending 的整个请求。

## 素材与授权

角色原图来自 Apprentice-Geo 的 AI-Fanworks，来源仓库声明 CC BY-NC-SA 4.0；素材署名保留 ApprenTice、ZipZipPipe，以及 DeepSeek 原角色作者上善无形。来源记录见 [AI-Fanworks 来源仓库](https://github.com/Apprentice-Geo/AI-Fanworks/tree/main/ApprenTice/AI-Girls-and-Chibis)。本次接入供非商业验证使用。商用或公开部署前必须确认授权范围，并保留署名与相同方式共享要求。

真实文本和图片模型调用会产生费用，并把创意内容与固定参考图发送给配置的模型供应商。代码接入和类型检查不代表视觉验收；首次效果评估由调用方显式发起。

## 代码

| 责任 | Implementation |
| --- | --- |
| 固定角色名单与参考图 | [`catalog.ts`](../../../../src/processes/character-emoji/catalog.ts) |
| 提示词、Schema、方案校验与修复 | [`src/processes/character-emoji/`](../../../../src/processes/character-emoji) |
| Pi 构思 Agent | [`agent.pi.ts`](../../../../src/processes/character-emoji/agent.pi.ts) |
| 本地素材与候选选择 | [`memes.ts`](../../../../src/processes/character-emoji/memes.ts)、[`materials.ts`](../../../../src/processes/character-emoji/materials.ts) |
| DeepSeek 搜梗与固定 Skill | `search.responses.ts`、`search.ts`、`skills.ts`、`.pi/skills/character-emoji-planner/` |
| Process 与图片 Capability | [`registration.ts`](../../../../src/processes/character-emoji/registration.ts)、[`capability.http.ts`](../../../../src/processes/character-emoji/capability.http.ts) |
| 图片生成与落盘 | [`src/business-api/crt-server.ts`](../../../../src/business-api/crt-server.ts)、[`character-emoji-image.ts`](../../../../src/business-api/character-emoji-image.ts)、[`magikaru-image-edit.ts`](../../../../src/business-api/magikaru-image-edit.ts) |

## 梗改编与提交校验

采用来源须保留可辨识的行为或对象关系并进入画面，只借主题词或引用旁白不算改编。不适合用户意图或没有可信来源时原创。用户未指定格数时选能讲清反差的最少格数。

单图公开方案为 `{ scene, actors, caption, propMarks }`；漫画为 `{ page, panels }`，每格为 `{ index, frame, scene, actors, texts }`。actors 只登记 character 和 identityMark。每格的 scene 独占动作、位置、表情、道具状态与可见笑点，以人物动作、作用对象和可见结果组织构图；用户要求的核心因果通过动作与道具关系表达，不能仅由台词或旁白解释。漫画可跨格完成因果，每格仍是一个可绘制瞬间；相邻格的变化直接在各自场景中承接，不再额外编写 continuity。删除 joke、composition、punchlineDetail 及 actors 的动作、表情、位置字段；不向旧字段复制 scene。Agent 决定 page.layout、readingOrder 和各格 frame；page 与 frame 仅表达画格几何，人物位置、姿势和道具状态只在 scene 编写。大小格、跨行跨列及明确嵌格均可使用，先按内容留出空间再选整页画幅。panels 按阅读顺序排列，嵌格计入总格数；程序只生成编号，生图忠实保留布局，不改成等分网格。

搜索条目由服务端生成同次内容ID，原生引用URL匹配且有摘要时标为 cited，其他材料标为 unverified；模型自写摘录不能变成原生证据。`usable` 表示有带引用摘要的非背景材料（语义仍需审查），`unverifiable` 表示只有未核验材料，可作为灵感但不宣称已经证实；`insufficient` 表示没有适合采用的联网条目，可选本地卡片或原创；`failed` 表示搜索失败，直接按需求原创。Agent 仍只能选择本次材料ID，来源正文不能授予权限。

`adaptation` 仅包含 entryIds 与改编/原创说明，根据完成的 scene 归纳，不把画外行动补写成已实现的改编。首次提交与修正后都由程序检查来源属于本次提供的本地卡片或同次检索非背景材料；Agent 提交前自行检查行为关系是否仍表达用户主题，以及人物姿势、道具占用与结果能否在同一瞬间成立。ID有效不代表改编成功；低推理预算也不保证语义正确，仍需固定来源对照验收。创作聚焦一个核心反差，每格定格一个核心动作；来源中的建议和解决流程按剧情需要取舍，结尾优先用可见后果或反应收住笑点，用户指定剧情优先。这些是创作指导，不新增姿势字段或语义硬门禁。

构思观测的 source 区分 original、local、research、mixed；另记录库版本和注入候选数。卡片 ID、选中内容、来源链接和改编说明不写入生产日志。来源类别仅说明 Agent 申报采用哪些材料，不能证明梗实际进入动作。

结构校验发现可定位的画面字段错误，或业务校验发现可修正的配字错误时，在原 Pi 会话发送错误路径与规则码，保留原需求、搜索资料及候选历史，关闭搜索，要求返回同一 Schema 的完整候选。上述字段修正与JSON格式重交共用一次机会，不生成另一套补丁协议或自评报告。

配字修正只允许改变本次报错的单图 caption；结构修正只允许修改已定位的画面字段，逐值比较其余原始候选内容。来源、角色身份、分格数量及未报错字段保持原值，不能重建整个候选或角色/分格容器。修正后重新执行结构、来源及完整业务校验，仍不通过则失败，不增加修正次数。指定配字的错误只能按原业务要求修正，不能借修正改写要求。

原生证据、内部候选及改编说明仅存在于同次请求，不进入正式输出、日志或 Run Record。不增加 Memebuy 任务、历史、恢复或计费持久化。

## 质量与验证边界

原生引用绑定只能说明材料来自本次搜索，不能证明网页真实。Agent 自检及程序结构校验均不等于梗或视觉质量已验收；程序只校验结构化文字字段，不从自由场景描述中推断文字，也不能保证成图无字。真实效果仍须用固定来源与用户需求人工审查。离线验收沿用固定输入与已有失败样本，分三层记录：搜索到方案的行为关系保留与主题一致性；方案到图片的关键动作、道具及跨格变化；图片的笑点可读性、角色、肢体和关键文字。失败与重试结果分别保留，比较总耗时与修正次数；这些标准不作为在线语义硬门禁，不追加每次生图后的复核模型调用。

新增 `test/character-emoji-scene.test.ts` 验证 v2 合同、单次场景编译、身份与文字边界及字段冻结；`test/character-emoji-agent.test.ts` 覆盖 v2 HTTP 与原会话修正。原有确定性测试位于 `test/character-emoji-submission.test.ts`、`test/character-emoji-agent.test.ts` 与 `test/character-emoji-comic-repair.test.ts`，维护来源身份、模式隔离、修正冻结、创作字段保留、单会话与预算边界。真实文本验收单独产生模型费用，不生成图片；生图验收另行授权。
