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

## 图片背景合同

- CRT 与照片海报的背景参数由 Process Schema 接受并贯穿 Capability、供应商请求和幂等摘要；只透传背景参数，不追加或改写提示词，省略保持旧行为。透明模式必须保留后处理 alpha，交付前核验透明及可见像素，失败不自动重绘。先部署 Pipipi，再开放调用方能力声明。
