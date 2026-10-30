# 仓库协作规则

## 开始工作

- 修改代码前先读 `CONTEXT.md`，再从 `docs/README.md` 找到对应专题文档。
- 修改或新增 Business Process 时，先从 [`docs/processes/README.md`](docs/processes/README.md) 选择 `memene`、`memebuy` 或 `common` 场景，再读取该场景入口。产品专属契约进入对应产品目录；多个产品原样复用的契约进入 `common`。
- 项目用 Business Process、Process Definition、Process Registration、Business Capability、Module、Interface、Implementation、Seam 和 Adapter 表达设计。用户口中的“工作流”在产品层映射为 Business Process；不要引入第二套 Workflow 领域模型。
- 保持 production catalog 显式、版本精确、服务端拥有。产品请求不能携带流程步骤、Skill、脚本、模型、Tool、来源地址或运行配置。
- 命名遵循 [`docs/development.md`](docs/development.md#命名规则)：使用能在当前作用域区分角色的最短名称，不重复目录上下文，也不使用自造缩写。
- `src/` 下每个源文件顶部必须有一行简体中文 docstring，一句话说明该文件的职责，便于开发时不通读全文件就能判断用途；新增文件或职责变化时必须同一改动中补齐或更新。

## 请求路由

- 用户用自然语言描述一段业务流程，并要求实现、封装或接入时，使用 `$author-business-process`。简短描述是有效输入；先从仓库事实推断安全默认值，只在公开契约、副作用或权限无法安全确定时提问。
- 用户给出 Skill 的本地路径、Git 仓库、仓库内子目录或网页地址，并要求使用、安装或接入时，使用 `$integrate-runtime-skill`。
- 同一请求同时包含流程描述和 Skill 来源时，先用 `$integrate-runtime-skill` 解析并审查来源，再用 `$author-business-process` 把已固定的 Runtime Skill 绑定到明确的 Process Registration。

## Skill 边界

- `.agents/skills/` 保存 Codex 在开发仓库时使用的 Development Skill；`.pi/skills/` 保存服务端受限 Agent 使用的 Runtime Skill。两者的调用方、权限和发布路径不同，不能只靠复制目录就互换角色。
- 本地路径或远程 URL 只作为开发、安装或构建期的 Skill Source。共享或生产使用前必须检查完整目录、来源、许可证、脚本、Tool 与网络权限，固定不可变版本并保存本地快照或可复现安装记录。
- 生产请求路径只读取随应用发布、由服务端选择的本地 Runtime Skill。禁止按请求下载、更新或执行任意远程 Skill。
- 当前有只读 Installed Skill Catalog，但没有通用 Skill Installer。Catalog 只校验并解析随应用发布的固定本地 Runtime Skill；生产确实需要多个来源类型时，可在开发工具链增加 Skill Installer。Catalog 和 Installer 都不得进入产品请求路径。
- 新增图片风格时，为每个稳定风格建立精确版本的 Process Registration，并复用受控图片生成与存储 Capability。产品请求只提交业务内容，不能选择 Skill、模型或供应商。

## Git 远端与同步

- `git@github.com:hkai-ai/pipipi.git` 是协作主仓库。保留其 `origin` 名称，并从该仓库获取和跟踪分支。
- `git@github.com:techidsk/pipipi.git` 是个人副本。保留其 `personal` 名称；不从该仓库拉取、合并或设置分支上游。
- 用户授权推送分支或 tag 时，把同一 ref 分别推送到 `origin` 和 `personal`，并确认两端指向同一 commit。

## 完成与验证

- 保留期、过期与时间窗口测试使用固定日期时，必须为读写两端显式注入同一时钟；不得依赖真实当前日期，也不得用可选链让记录缺失误判为通过。

- 新增 Business Process、接入 Runtime Skill 或改变公开行为时，同步更新测试、`README.md`、`CONTEXT.md`、所属场景入口和受影响的 `docs/` 页面。
- `POST /internal/eval/execute` 只用于受控内部新闻图片评测，由 `INTERNAL_EVAL_ENABLED` 挂载。它必须复用同一次 Process 执行，只在响应中投影实际 Prompt、模型和非敏感图片参数；不得把这些内容写入正式输出、日志或 Run Record。该入口不实现独立鉴权，鉴权与 `/execute` 一并后续统一处理。
- 面向产品调用方的全部业务 HTTP Interface 统一维护在 `docs/api.md`；健康检查等运维 Interface 留在 Runbook，Process 专题文档只保留业务行为与实现说明。
- 默认运行 `npm run check`、`npm run typecheck`、`npm test` 和 `npm run build`。需要网络、凭证、费用或外部写入的 smoke 必须单独说明，不把它混入确定性验证。
- 新增 Process 启动变量时，同步异步环境预检的 API/Worker 允许清单与生成脚本的 `agent_keys`；新增独立执行时限时，验证完整生产目录的 Worker 构造，集成测试默认使用 Worker 按目录计算的租约。
- 文档以中文为主，遵循 `docs/README.md` 的分类、事实来源和写作规范。

## CRT 图片输入

- `crt-interface-image/v1` 接收公网 HTTPS `sourceImageUrl`。服务端不下载参考图；FAL Adapter 将 URL 原样放入 `image_urls`。完整 URL 不得进入日志或证据，只保存摘要。
- CRT 最终 PNG 可由服务端配置保存到阿里云 OSS；FAL、模型、OSS 凭证、bucket 和对象前缀不得进入产品请求。

## 单服务器发布

- 镜像构建必须以非 root 身份、禁网运行完整 production catalog 的 Runtime Skill 校验（含可选 Process）；新增 Skill 同步维护 Dockerfile 和 `.dockerignore`，不能只验证工作区文件。

- 修改同步 Process 执行预算或重建网关反代时，按 `docs/mvp-release-runbook.md` 的“同步模板请求的网关超时”核对 Process、网关和调用方的等待余量，并保留精确 location 的鉴权与身份头。

- 标准单服务器发布入口是 `.github/workflows/production-ci-cd.yml`。CI 构建不可变的 `pipipi:<commit>` 镜像，生产 Job 通过 SSH 上传镜像归档，再用 `compose.production.yaml` 重建主 API 与内部 CRT Business API；不要恢复 PM2 或 release 目录作为日常发布路径。
- 日常发布在锁内保留服务器当前同步或异步形状；已有异步部署由 `ops/update-async-release.sh` 更新六个角色，保留阶段、队列与角色环境。普通更新不执行数据库迁移，迁移文件变化仍走带备份审查的显式发布；禁止借普通发布退回同步或重置灰度阶段。
- 两个容器都使用 host 网络；主 API 监听 `0.0.0.0:4300`，内部 CRT Business API 只监听 `127.0.0.1:4400`。服务器防火墙不得向公网开放应用端口。基础 Compose 保持 `ASYNC_PROCESS_RUNS_ENABLED=false`，不包含 PostgreSQL、Redis 或异步角色。
- 服务器环境变量保存在 `REMOTE_PATH/shared/.env`，不得写入 GitHub Actions 日志、镜像或仓库。部署必须校验两个容器的 image tag、`com.pipipi.revision` label、`/healthz` 和 `/readyz`；任一失败都恢复上一镜像和 Compose 形状。

## Agent skills

### Responses 联网搜索

- 需要模型原生联网搜索的 Process 使用服务端固定的 OpenAI Responses Adapter，并把 `web_search` 设为必需；关键词预算由 Registration 固定，调用方不能控制搜索 Tool 或模型。
- 只有确认响应包含已完成的搜索调用后才把检索视为成功；检索结果按不可信资料传入后续构思，并且不得进入正式输出或运行日志。

### Issue tracker

项目规格与工作项使用 GitHub Issues。详见 `docs/agents/issue-tracker.md`。

### Triage labels

项目使用五个默认 triage 角色标签。详见 `docs/agents/triage-labels.md`。

### Domain docs

项目使用 single-context 领域文档布局：根目录 `CONTEXT.md` 与 `docs/decisions/`。详见 `docs/agents/domain.md`。

## 照片海报

- 预设标识描述配色与版式；旧标识仅在输入 Schema 归一化，复用同一套设计规则。产品侧持久化的模板、能力身份不随预设业务值改名。

- 同一照片风格的预设和编辑项是受控业务参数，由服务端固定目录解析默认值与覆盖关系；油墨分工跟随最终解析的配色与版式，用户原文优先于预设分行。不为参数组合复制 Process，不把预设名当海报文案，不改变参考主体动作。兼容新增可选参数时保留旧调用行为。

- 照片海报风格的精确身份与顺序由 `src/processes/photo-poster/style.ts` 拥有，复用同一受控 Rendering Capability。正式输出只包含完整风格化成品，不附原图、不做上下对照；所有参考图保持 URL 直传，原图对照仅用于验收报告，不扩大 Agent 权限。
- 漫画分镜的画格属于完整重绘成品，不是原图对照；固定预设同时约束文本编译与成图。细节取自当前参考图，不把验收样图的角色、配饰或手势固化进通用规则。
- 新增固定 SHA-256 的 Runtime Skill 时，同步在 `.gitattributes` 锁定其 `SKILL.md` 为 LF，避免 Windows checkout 改写已校验字节。

## 图片模板编译

- 模板失败诊断只记录运行关联、阶段和净化后的结构问题；动态键隐藏为 `*`，不记录原始错误消息或候选正文。诊断 Sink 失败不得改变业务结果与调用预算，详见 Memebuy 模板专题。

- `template-from-image/v1` 通过受控下载与解码向无 Tool Agent 传入真实图片附件。返回草稿必须通过固定 Gallery Schema 和业务语义校验；状态、图片引用与尺寸由服务端拥有，Agent 不访问 key 注册表或模板库。修改固定 Schema 时同时更新摘要和 LF 约束。

## 模板编译质量

- 模板编译的像素测量只作为同次看图的辅助证据：单一背景且内容带可分离时提供前景上下缘，复杂背景跳过。不得把墨迹外缘当成字体基线、采样段当成字符或自动判定弧形；测量不进入正式草稿、运行记录或审批摘要。模型请求先列逐区观察，再列取舍与正式语义。

- 模板视觉取舍必须能从原始 fieldEvidence 对账到保留或舍弃理由及正式约束；独立复核同时检查观察遗漏、取舍依据和执行句。程序只验证覆盖和引用，不以结构通过代替视觉验收，不将所有原始观察强制冻结。

- 模板编译以来源分析合同为准：fieldEvidence 保留原始依据，textRegions 保留角色、语言、布局、位置与路由；选定稳定事实进入 mediumComposition。Prompt 与运行语义仅在 analysis.semanticModel 编写，再投影为正式草稿；不从草稿回填观察，不要求固定六轴排版。修改来源规则时同步正反例，字段通过不证明视觉正确。

- 独立复核通过请求级严格 JSON Schema 固定补丁、现有可修改路径、输入摘要和报告形状；`valueJson` 仅作补丁值的传输编码，解析后执行原合同，不降级普通 JSON 模式或补填通过结论。
- 复核证据范围独立于有界补丁路径；大候选不能截掉正式视觉合同或必需观察，严格响应 Schema 不得产生空枚举。变更时用大候选验证 Schema 可满足。
- 编译观察保留完整总览，辅助内容图不能切断文字行或组件组；近似背景裁边仅供观察，不能改变正式图片、留白或审批依据。原预处理的固定局部模式单独保留。

- 有文字时，复核传输按原始文字观察与正式视觉约束分组并分别约束引用路径；解码只合并证据，不补写判断。选定事实不一致时提供两边精确路径与原值，由模型在原预算内修正，不以同义改写或自动拼接绕过来源合同。

- 图片转模板的来源业务文档在开发期核验摘要后完整打包，不以摘要版 Skill 宣称等价接入；`tools/build-template-skill.ts` 不进入请求路径。
- 模板 Skill 的业务取舍以固定来源原文为准，适配层只补运行边界与字段映射；更新生成器后重建快照、版本和摘要，并用 `--check` 及逐文档摘要测试核验一致性，不单独手改打包正文。
- 模板先生成 analysis、draft，再由独立无 Tool 会话重新看图核对，直接返回必要补丁和十九项最终报告；正常两次请求，仅首轮 JSON 或候选结构无法读取时允许一次重新编译，最多三次，之后仍须独立复核。分析、复核和内部指令不进入公开草稿。
- 模板独立分析保留选定的视觉事实；语义副本、引用展开和推荐项代入由服务端投影。引用失效或分析与草稿不一致进入原有修正预算，不自动拼接冲突句子；自复核仍需审查原图事实、八轴取舍与推荐项特征兼容性。
- 独立复核绑定服务端输入计划摘要，不沿用生成者自评；响应包含有界补丁及对最终候选的完整报告。程序合并后重做全部校验，不默认追加模型复核；未解决问题直接失败，不能代填通过或把摘要匹配当成视觉正确。
- 结构完整的模板候选使用有界字段补丁修正，服务端保留未涉及内容；不得为修一项而重新生成整份候选。结构无法读取时才允许完整重新编译，调用预算不增加。
- 模板特征权限与复核报告使用具名对象，部分分析继续使用紧凑行；九轴权限按 replace_identity binding 要求，其他槽位为 null。证据按固定来源要求非空且具体，不新增最少字符门禁；分析中的简短证据最多 96 字符，复核 observation 最多 500 字符，正式视觉事实不受此限。复核上下文直接读取引用计划，引用错误不得吞掉其他有效约束；完整业务校验和公开 Gallery JSON 保持不变。

## 模板图片预处理

- 模板内容重编译复用原成图审批和内容寻址图片；本轮编译要求独立传入编译器，不混入图片批准、不改写原方案或触发生图。调用方以新候选及新运行保留历史，技术失败仍恢复原运行。

- 原图观察先于替换决策；同一请求的有界局部图只辅助细节观察，总览决定数量和构图，裁片不得进入生产源图或审批图。排版观察先于新文案并由程序投影，不能用阅读方向代替几何。模型请求可调整字段顺序，但不得重排参与已存审批摘要的策略 Schema。十二段指令只投影已批准业务要求，不携带校验标志或研究记录；真实视觉验收须保留失败样本，不能把字段通过或人工补充提示后的成图当成自动分析通过。

- 替换方案校验在原执行预算内最多允许一次相关字段补丁，合并后重跑全部合同；诊断只记录阶段、固定规则码与字段名，不能记录候选、原始异常或动态键。模型执行错误不触发方案重投。

- 原图片生产 Skill 的策略与成图两次审批由 Memebuy 页面承接；Agent 不代替人工批准。成图审批前不上传模板 OSS，已知请求只恢复同一请求，未知生成提交禁止自动重投。
- 审核 PNG 的大输出预算只能由固定 Registration 声明；同步核验调用方加密交接上限与按需加载。审批绑定 productionId、当前对象摘要及成图审核包摘要；草稿编译复用审核通过的内容寻址图片。

- 预处理生图指令由结构化策略确定性生成并随执行合同版本、摘要落盘；批准绑定精确指令。旧方案未提交时重新规划审批，已有 requestId 只恢复原请求。画布、冻结范围及逐区文字检查只证明结构一致，视觉事实仍由人工审核。
- FAL 预处理生成走固定地址单次 HTTP POST，不能依赖 SDK 队列的全局重试开关。明确非重试 4xx 保存 provider_rejected，其余不确定提交保存 submission_unknown；两者均不恢复已消费批准。状态查询和托管必须将取消传到底层 HTTP。

- 同方案重新生图使用调用方持久化的全新 `renderId`，恢复必须复用原值；审核包摘要、成图审批、上传及编译都绑定该成图身份。缺省 renderId 保留旧合同，禁止清空旧 attempt 或借恢复重新提交供应商。

## 角色表情包

- v3 按角色 + appearance 区分演员，dialogue.speaker 使用 character:appearance；参考图按 cast 顺序绑定 Memebuy 场景版素材。维护角色素材时核对两边目录，保留 v2 旧协议及旧图地址；完整版本契约见角色表情包专题的“双版本登场 v3”。

- 本地梗库由服务端维护并按角色、题材挑选短卡，与角色背景独立提供；选材不增加模型调用。v2 的 adaptation.entryIds 最多引用两个本次提供的本地或联网材料，原创为空数组，搜索失败仍直接原创。来源只作内部归因，不进入公开方案或图片提示词；维护入口及边界见角色表情包专题。

- `character-personas.ts` 原样维护从 Memebuy 迁入的角色创作背景，单图与漫画按角色 ID 注入 creativeBrief；它启发行为，不覆盖用户剧情或参考图外观，不作为本次检索证据。不能以精简提示词为由删除已维护设定。明确全画面无字优先，其次遵守 custom/none；auto 或缺省结合 idea 决定配字，构思、校验与生图共用 textPolicy。

- 台词和标识按方案准确绘制，场景可包含必要短字、数字及符号；非关键辅助文字允许模型少量补充，不设置通用台词禁词或全量文字白名单。明确无字要求贯穿构思与生图并优先于配字设置；白底动漫贴纸是单图默认风格，具体规则见角色表情包专题。
- 同一个 DeepSeek 4.1 Flash Pi Agent 默认选用本地素材或原创并自检，服务端按 idea 的明确检索或近期事实要求开放搜梗；普通创作不注册工具，载荷移除搜索工具，执行入口重复检查权限，不启动独立复核；专用 Pi Session 仅加载公共及当前模式的固定 Runtime Skill，获准时只暴露 search_memes Tool，其内部固定使用 DeepSeek Responses 原生联网。检索完成后关闭工具；未核验资料可作灵感，原生搜索失败、子预算超时、响应不完整或拒绝时直接原创；用户取消和整体截止仍停止。Registration 拥有共享时限、模型轮次、搜索次数、关键词与构思推理预算（首轮判断与构思为 low，字段修正为 none），ModelRuntime、凭证与设置均在内存中隔离全局 Pi 配置。4.1 Flash 网关使用 JSON 模式，构思及修正请求携带同一候选 Schema，返回后仍执行全部本地校验。 构思及修正请求不发送 max_output_tokens，并在 onPayload 移除 Pi 自动补入的上限；采用上游默认输出额度，保留共享截止时间，搜索输出预算独立维护。
- 当前 production catalog 保留 `character-emoji/v2` 并注册 `character-emoji/v3`，公开方案每格仅由 `scene` 拥有动作、位置、道具状态与可见笑点；actors 仅登记身份与标识，准确文字保留专用字段。图片编译只投影一次 scene，不回填旧创作字段。单图、漫画与公共 Skill 从各自源规则完整生成；修改后运行 tools/build-character-emoji-skill.ts 并以 --check 核对全部快照及精确绑定。每个事实由一个字段拥有；失败样本保留在验收材料中，通用提示词不累加具体剧情禁例。
- 初稿与修正稿均校验同次来源、结构及原业务合同。JSON 不可读、可定位的画面字段结构错误与配字错误共用一次原会话修正机会，保留需求和搜索历史并关闭 Tool。JSON 不可读时要求仅修格式并重交完整候选，无法保证逐字段冻结，重交后执行完整校验；可读取候选只改报错字段，其余逐值冻结。来源错误、角色或分格容器不合法时停止；修正失败不追加轮次。诊断只保留固定类别、净化字段路径与规则码，不保存正文。结构及来源通过不代表画面语义验收。
- 构图、视觉笑点及跨格变化由 Agent 在各格 scene 中直接创作，以动作、作用对象和可见结果表达用户要求的核心因果，不仅靠台词或旁白解释；提交前在同次请求检查肢体动作、道具状态和结果数值的自洽，不输出自评报告。Agent 决定整页布局、阅读顺序与各格 frame，允许大小格、跨行跨列和明确嵌格；page 与 frame 仅描述画格几何，动作统一由 scene 拥有，adaptation 只归纳已写画面的关系。程序只按阅读顺序生成编号，不新增独立语义复核或道具状态表。
- 方案只读取 Pi 文本块中标记的 final_answer；无该标记时排除 commentary，不拼接中间说明或推理，不从混杂文本中截取 JSON。
- 单次搜索最多返回两个候选，由 Agent 按用户要求的行为关系取舍；搜索条目由服务端生成同次内容 ID；引用与摘要可用时绑定，缺失只标为未核验，不清空资料。背景与不足说明不能升级为已证实的社区梗；Agent 自检行为是否进入画面。资料与改编说明只留在请求内，不进入公开输出、日志或持久化。
- 搜索最多占用30秒且不超过剩余时间的三分之二，仍计入120秒共享预算。搜索材料以短摘要和引用片段交给 Agent，完整绑定留在请求内。搜索 Adapter 保留固定错误分类，Agent 把搜索失败转为原创结果并关闭 Tool；不自动补查，不把取消或整体超时当作可继续的失败。单图按角色 ID 绑定动作及参考图，数组错序可接受；角色缺失、重复或名单外身份仍拒绝。请求级观测记录搜索结果、兜底原因码、阶段耗时、主模型调用及修正次数，观测失败不影响执行。诊断不得记录正文、来源、凭证或原始异常。
- 图片主用 Memene gpt-image-2.5-flare、备用 Magikaru External Job gpt-image-2.5；Flare 对齐已核验的 Memebuy 请求，省略 quality/output_format，不继承 CRT 参数；白名单角色原图优先经已配置的同桶 OSS 读取（未配置 OSS 的独立运行保留公网取图），不缩放、不压缩、不转码，并行读入内存后按原顺序 multipart image[] 上传，不落临时文件、不向素材请求发送网关凭证；OSS GET 签名只留请求内，不进入模型或日志；Magikaru 保持 URL 直传；两路共用300秒预算，配置备用时主用上限180秒。主用任意错误（含提交未知、5xx、主用超时与图片读取校验失败）切换一次备用；主动取消或整体截止仍停止，备用失败不重投。主备观测分别保留净化结果。图片专用凭证只由内部图片服务读取，不复制到 Agent 环境；Magikaru 受理后保存 jobId 与 deadlineAt，只轮询原 Job。图片提示词由原业务编译器生成。

## 图片背景合同

- CRT 与照片海报的背景参数由 Process Schema 接受并贯穿 Capability、供应商请求和幂等摘要；只透传背景参数，不追加或改写提示词，省略保持旧行为。透明模式必须保留后处理 alpha，交付前核验透明及可见像素，失败不自动重绘。先部署 Pipipi，再开放调用方能力声明。

角色可用形象按固定参考图目录校验，不能假设每位角色都有 Chibi 与 Girl；新增角色须同时同步调用方的形象限制、创作背景及本地素材，部署服务端支持后再开放调用方。
