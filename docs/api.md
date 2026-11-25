# 业务接口文档

本文面向产品调用方和调用 Agent，说明 Pipipi 的接入边界、认证、执行模式、费用、错误与重试语义、Webhook 验签以及非 Schema 可表达的流程行为约束。**全部已启用 Business Process 的精确版本清单、字段类型、必填项、枚举、长度限制、请求与响应结构由服务端从注册表实时派生，请以 OpenAPI 3.1 契约为唯一字段事实来源**：

- 全量 OpenAPI 3.1 规范：`GET /openapi.json`（`x-pipipi-processes` 列出当前已启用的精确 `(process, version)`、`timeoutMs` 与单切片路径）；
- 单 Process 轻量化 JSON Schema 切片：`GET /openapi/processes/{process}/{version}.json`（推荐调用 Agent 按需拉取，避免读取全量规范）；
- Agent 导航入口：`GET /llms.txt`（兼容 `GET /llm.txt`）；
- 本页纯 Markdown：`GET /docs/api.md`。

> 服务端拥有全部 Process Definition、Runtime Skill、模型、Tool、供应商与运行配置。产品请求只能提交业务输入，不能携带 `messages`、role、Prompt、Skill、Tool、模型或步骤；不提供 `latest` 别名、默认版本或版本回退。

## 接入信息与选型

| 项目 | 约定 |
| --- | --- |
| Base URL | `https://pi.ganjiuwanshi.com` |
| 精确 Schema 契约 | `GET /openapi.json`（全量）；`GET /openapi/processes/{process}/{version}.json`（单流程切片）；`GET /processes`（含运行发现视图，`Cache-Control: no-store`） |
| 业务路由 | `POST /execute`、`POST /process-runs`、`GET /process-runs/{runId}`、`GET /memebuy/template-runs/{runId}/diagnostics`；按开关挂载 `/agent-conversations*` 与 `/internal/eval/execute` |
| 编码与上限 | `Content-Type: application/json`，UTF-8；应用请求体上限 262,144 字节 |
| `X-Request-Id` | 可选链路追踪头（1–200 字符，`A-Za-z0-9_.:-`），写入所有日志但不回显、**不提供幂等性** |
| 客户端读取超时 | 常规同步 Process 上限 240 秒（建议客户端 >= 260 秒）；`template-master/v2` 上限 360 秒；图片转模板上限 480 秒（建议 >= 500 秒）；`product-remix/v1`（660 秒）与 `template-master/v1`（2400 秒）请使用异步 `/process-runs` |

| 执行方式 | 适用场景 | 幂等与重试边界 |
| --- | --- | --- |
| `POST /execute` | 同步等待单次结果 | **无调用方幂等键**；超时或模糊失败不代表未执行，付费图片流程严禁自动重试 |
| `POST /process-runs` | 长耗时任务、可靠受理、轮询与安全重放 | 必填 caller-scoped `Idempotency-Key`；响应丢失时复用同一 key 与规范化请求重放 |
| `/agent-conversations*` | 多轮文本/图片引用与受控 Process Tool | 默认关闭（`AGENT_CONVERSATIONS_ENABLED=false`），当前生产 Agent catalog 为空，未登记生产 Agent 前不可开启 |

### 最短接入路径

1. 从 `GET /openapi.json` 的 `x-pipipi-processes` 或 `GET /openapi/processes/{process}/{version}.json` 确认精确 `process`、`version` 和 `inputSchema`。
2. 零费用联调 HTTP 链路时，可向 `minimal-zine-poster/v1` 提交空 `input: {}`，服务在调用模型前返回 `400 INVALID_INPUT`。
3. 同时判断 HTTP `2xx` 与响应体 `status === "succeeded"`，切勿只看 HTTP 状态码。
4. 保存 `runId` 和调用方生成的 `X-Request-Id` 用于排查。

```bash
# 以下有效请求会产生模型与图片费用；Base URL 和 API Key 由部署方提供
curl --request POST 'https://pi.ganjiuwanshi.com/execute' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer <ppk_...>' \
  --header 'x-request-id: replace-with-your-trace-id' \
  --data '{
    "process": "minimal-zine-poster",
    "version": "v1",
    "input": { "brief": "为雨天旧书店做一张安静的海报" }
  }'
```

## 调用方认证

调用方后端通过 `Authorization: Bearer <ppk_...>` 向 `/execute`、`/process-runs` 和 `/agent-conversations` 提交同一把服务端发放的 API Key。明文只在发放时展示一次，应保存在服务端 Secret 中，严禁放入浏览器、URL、业务输入或 `X-Request-Id`。

一个稳定 `callerId` 可持有多把 Key；轮换时先发新 Key、切换后再吊销旧 Key，运行归属、幂等键、Webhook 与积压上限均按 `callerId` 保持连续。吊销或过期只影响后续认证，不取消已受理运行。密钥管理操作见[调用方 API Key 管理与迁移](mvp-release-runbook.md#调用方-api-key-管理与迁移)。

| `EXECUTE_AUTH_MODE` | `/execute` 认证行为 |
| --- | --- |
| `open`（默认） | 不解析身份，放行请求，不写入 `callerId`/`authMethod` |
| `audit` | 尝试认证；缺失、无效或存储异常仍放行，并记录脱敏 `execute_anonymous` 日志 |
| `required` | 缺失、无效、过期或吊销返回 `401 CALLER_UNAUTHORIZED`；认证存储异常返回 `503 CALLER_AUTH_UNAVAILABLE` |

过渡期开关 `CALLER_AUTH_GATEWAY_FALLBACK=true`（默认）允许未携带 `ppk_` Key 时兼容可信网关注入身份；一旦携带 `ppk_` 前缀则只验 API Key、不回落网关。公网调用方严禁自行发送 `X-Pipipi-Caller-Id` 或 `X-Pipipi-Gateway-Token`。

## 异步执行

异步入口由 `ASYNC_PROCESS_RUNS_ENABLED=true` 显式开放（默认返回 404），始终要求调用方认证和 `Idempotency-Key`（UTF-8 最长 512 字节，按 `callerId` 隔离）。请求体与 `/execute` 相同；精确 Schema 见 `GET /openapi.json`。

```bash
idempotency_key='replace-with-one-stable-operation-id'

curl --include --request POST 'https://pi.ganjiuwanshi.com/process-runs' \
  --header 'authorization: Bearer <ppk_...>' \
  --header "idempotency-key: ${idempotency_key}" \
  --header 'content-type: application/json' \
  --data '{
    "process": "minimal-zine-poster",
    "version": "v1",
    "input": { "brief": "为雨天旧书店做一张安静的海报" }
  }'

curl --include \
  --header 'authorization: Bearer <ppk_...>' \
  'https://pi.ganjiuwanshi.com/process-runs/<runId>'
```

- **受理与幂等重放**：返回 `202`、`Location: /process-runs/{runId}`、`Retry-After` 与 `Cache-Control: no-store`。同一 `(callerId, Idempotency-Key)` + 规范化相同请求返回原 `runId` 及其当前真实 `status`（`queued` / `running` / `succeeded` / `failed`）；不同请求体返回 `409 IDEMPOTENCY_CONFLICT`。
- **轮询与归属隔离**：`GET /process-runs/{runId}` 成功始终返回 HTTP `200`（即使 Run 终态为 `failed`），非终态附带 `Retry-After`。未知或非本 caller 所有的 `runId` 统一返回 `404 PROCESS_RUN_NOT_FOUND`。
- **结果过期**：结果内容到期后保留真实终态、时间与 `cost`，用 `resultAvailability: "expired"` 和 `resultExpiredAt` 替代 `output` / `error`。
- **容量与停流**：caller 积压满返回 `429 CALLER_BACKLOG_LIMIT_REACHED`；全局积压满返回 `503 ASYNC_SERVICE_CAPACITY_REACHED`；运维停流返回 `503 ASYNC_INTAKE_CLOSED`（不影响已有查询和同步 `/execute`）。以上均带 `Retry-After`，且在写入幂等记录前拒收、零费用，可用同一 `Idempotency-Key` 安全重投。

## Webhook 通知

异步入口开放且服务端已为调用方预注册 Webhook Endpoint 时，服务在 Run 到达终态后发送 `process_run.succeeded` 或 `process_run.failed` 事件（payload 结构见 `GET /openapi.json` 的 `webhooks` 节）。产品请求不能携带 Webhook URL；事件体不携带业务输入、输出或内部错误，接收方验签后使用同 owner 凭证读取 `data.resultLocation`。

请求附带 Standard Webhooks 头：`webhook-id`（即 `eventId`，重试不变）、`webhook-timestamp`（Unix 秒）与 `webhook-signature`（一个或两个空格分隔的 `v1,<base64-hmac>`，双签名表示 Secret 轮换）。验签必须保留原始未重序列化请求体，去除 Secret 的 `whsec_` 前缀并 Base64 解码得到 HMAC key：

```text
signed = webhook-id + "." + webhook-timestamp + "." + raw-request-body
expected = "v1," + base64(HMAC-SHA256(key, signed))
```

使用常量时间比对任一 `v1` 签名、校验时间戳偏差、按 `eventId` 幂等落库后再返回 `2xx`。投递采用至少一次语义，网络错误/超时/`429`/`5xx` 重试，`3xx` 不跟随，`410` 停用 Endpoint。

## 费用、错误与公开文案约定

### 运行费用（`cost`）

所有带 `runId` 的 `/execute` 响应及 `/process-runs` 终态响应均可附带 `cost: { currency: "USD", amount, source, complete }`：

- 累计单次 Run 内所有模型与图片调用（含修正、复核、子步骤与异步重试 Attempt）；无任何已知费用时省略整个 `cost`，绝不以 `0` 冒充免费。
- 供应商明确回报 `0` 按 `0` 计入；FAL、Magikaru、缺失费用头的网关响应、超时/取消在途调用或因 Worker 崩溃丢失的 Attempt 记为未知（`complete: false`，此时 `amount` 为已观测下限）。
- 恢复既有结果不产生新调用，不重复计费；传输层 429/503 拒收无 `runId` 且不带 `cost`。

### 错误响应与 `400` 校验详情

- `/execute` 与 `/process-runs` 在 HTTP `400` 入参或上游引用校验失败时，统一返回 `error.code`、`error.message` 与字段级 `error.details`（`[{ path, keyword, message }]`），在入队和模型调用前拦截，零费用且不占用 `Idempotency-Key`。
- 公开错误码（完整枚举见 `/openapi.json` 的 `ProcessErrorCode` 与 `TransportErrorCode`）保持稳定；`error.message` 是经服务端净化的中文说明（不回显 Prompt、凭证、签名查询参数或内部堆栈），调用方应按 `error.code` 分支，不要解析文案。
- 公开文案只陈述已知失败事实与必要的副作用约束（例如“可能已产生费用，请勿直接重新生成”），运维排查建议仅展示在控制台。

## 重试判断

| 结果 | 调用方动作 |
| --- | --- |
| 异步提交未收到 `runId`、响应丢失、客户端超时，或返回 `429` / `503` | 等待 `Retry-After`，**复用同一个 `Idempotency-Key` 和完全相同的请求**重试；不得生成新 key |
| 异步 `GET /process-runs/{runId}` 返回 `503` | 等待 `Retry-After` 后安全重试同一个 GET |
| 同步 `/execute` 返回 `503 SERVICE_BUSY` | 执行尚未开始，等待 `Retry-After` 后可重试 |
| 任意入口返回 `INVALID_INPUT`、`PROCESS_NOT_FOUND` 或其他确定性 `4xx` | 修正请求后再调用 |
| 同步调用网络超时、连接中断、`PROCESS_TIMEOUT` 或 `DEPENDENCY_FAILURE` | 外部副作用可能已发生；按 `X-Request-Id` 排查，付费图片 Process **严禁自动重试** |
| `DEPENDENCY_FAILURE_AFTER_COMMIT`、`MASTER_NOT_ACCEPTED`、`MASTER_BUDGET_EXHAUSTED` | 已越过计费或预算耗尽点，**严禁自动重试** |

## Agent Conversations（多轮文本与图片资源）

> production Agent catalog 当前为空（原 `design-assistant/v1` 已下线待重构），因此默认部署未开启且开启 `AGENT_CONVERSATIONS_ENABLED=true` 会在启动时失败；本地契约联调可使用 `npm run dev:agent`（提供确定性文本桩）。四个路由的请求/响应 Schema 见 `GET /openapi.json`。

- **路由与幂等**：`POST /agent-conversations`（创建并提交首轮）、`POST /agent-conversations/{id}/turns`（凭最后接受的 `afterTurnId` 追加）、`GET /agent-conversations/{id}?after=<cursor>&limit=1..100`（按 owner 分页）、`DELETE /agent-conversations/{id}`（立即 fencing 并在 `deleteBy` 前级联清理，不需要 `Idempotency-Key`）。创建与追加各需独立稳定的 `Idempotency-Key`。
- **单活跃 Turn 与顺序**：每个 Conversation 同时至多有一个 `queued`/`running` Turn；冲突返回 `409 CONVERSATION_BUSY`（附 `Retry-After`），`afterTurnId` 过时返回 `409 CONVERSATION_SEQUENCE_CONFLICT`。同 caller + 同 key + 同请求的幂等重放优先于 busy/顺序/容量判断。
- **配置版本与保留期**：创建时将服务端行为配置的 SHA-256 写入 `configRevision`；闲置保留 30 天（每次接受新 Turn 续期，只读查询不续期）。
- **图片资源与 Tool 边界**：输入仅接受部署方 owned resource service 属于当前 caller 的稳定 `resourceId`（默认每轮最多 4 张、单图 10 MiB、合计 20 MiB、8192×8192，仅 JPEG/PNG/WebP），不接受 URL/base64 上传；响应中的图片临时 `url` 与其 `expiresAt` 仅查询时投影，不持久化。服务端固定 Process Tool allow-list（默认每轮最多 6 次、其中付费 Tool 最多 1 次，每 Conversation 最多 10 次付费 Tool）；priced Tool 进入结果不确定窗口后落 `DEPENDENCY_FAILURE_AFTER_COMMIT`，禁止自动重试。

## 图片背景参数

CRT 与十一个照片海报 `v1`、以及 `mono-color-photo-poster/v2`、`character-emoji/v3~v4` 接受可选 `background`（枚举见对应单切片 Schema），省略时保持原行为。参数直接传给绘图模型，不改写提示词；透明成品交付前校验同时存在可见与透明像素，不合格则失败且不自动重绘。该字段参与下游幂等摘要，不可复用同一键切换背景。

## 内部新闻图片评测

`POST /internal/eval/execute` 由 `INTERNAL_EVAL_ENABLED=true` 挂载（关闭返回 `404 ROUTE_NOT_FOUND`），仅接受三个新闻图片 Process（其他返回 `400 INVALID_INPUT`），复用同一次正式执行并在 `200`（`Cache-Control: no-store`）响应的 `output.generation` 中投影实际 `prompt`、`promptModel` 与非敏感图片参数；诊断字段不进入正式 `/execute`、日志或 Run Record。该入口会产生模型与存储费用，不适用 `/execute` 三档认证，访问控制由入口网关负责。

## 模板执行步骤

- **同步附带**：调用 `template-from-image` 时在 `POST /execute` 附加 `X-Pipipi-Template-Steps: 1`，响应可与 `output`/`error` 同级附带脱敏 `diagnostics: { runId, process, version, steps }`（不改变执行状态、费用或重试合同）。
- **历史只读查询**：`GET /memebuy/template-runs/{runId}/diagnostics` 使用独立只读凭证 `Authorization: Bearer <MEMEBUY_TEMPLATE_DIAGNOSTICS_TOKEN>`（至少 32 字节），仅返回保留期内 `template-from-image` 的脱敏步骤与最多 8 条校验 `issues`；未授权返回 `401`，未找到返回 `404`，未配置归档或凭证返回 `503`。Schema 见 `GET /openapi.json`。

## Process 行为边界与专题入口

> 各 Process 的完整入参/出参字段、枚举、正则与长度上限请直接查阅 `GET /openapi/processes/{process}/{version}.json`；本节只保留 Schema 无法表达的运行时行为、计费与授权边界。完整场景目录见 [`docs/processes/README.md`](processes/README.md)。

### 照片海报

涵盖 11 个照片海报 `v1` 与 `mono-color-photo-poster/v2`（单切片如 `/openapi/processes/dopamine-photo-poster/v1.json`）。成品默认 1200×1600 PNG（`risograph-album/v1` 为 1200×1200 PNG），除 `memory-checklist-photo-poster/v1` 上半保留原片外均为独立风格化成品；不接受批量上传，原图 URL 不进入文本 Agent。已发起图片调用后失败落 `DEPENDENCY_FAILURE_AFTER_COMMIT`，禁止自动重试。各风格细节见[`docs/processes/common/README.md`](processes/common/README.md)。

#### 漫画分镜

`manga-panels/v1`（`/openapi/processes/manga-panels/v1.json`）：固定三格黑白无字漫画，支持 `three-panel-details`（默认）与 `sketchy-mixed-panels`；不接受任何文字或对话框字段。详见[漫画分镜专题](processes/common/manga-panels/README.md)。

#### 日式时装漫画文案

`photo-fashion-manga/v1`（`/openapi/processes/photo-fashion-manga/v1.json`）：`text`、`kicker`、`caption` 独立覆盖；**传空字符串或纯空白表示去掉该文案元素**，`null` 无效。主标题保留显式换行，无换行时按自然词界适配两行。详见[日式时装漫画专题](processes/common/photo-fashion-manga/README.md)。

#### 双色海报 v2

`mono-color-photo-poster/v2`（`/openapi/processes/mono-color-photo-poster/v2.json`）：由调用方传入完整冻结搭配（`primaryInk` 与 `accentInk` 忽略大小写须不同，不接受 `preset` 占位），可选传 `sourceImageSha256` 供多媒体网关复用原图标识；服务端绑定 Flare 渠道。详见[双色海报专题](processes/common/mono-color-photo-poster/README.md)。

#### Mono Color 可编辑预设

`mono-color-photo-poster/v1`（`/openapi/processes/mono-color-photo-poster/v1.json`）：未传任何设计参数时保持 Skill 自动搭配；仅传调整项未传 `preset` 时以 `blue_orange_overlap` 为基准。输入处兼容旧版别名（`within_reach` → `blue_orange_overlap`、`half_hidden` → `blue_orange_diagonal_crop`、`your_move` → `black_red_statement`、`hold_still` → `black_red_frame`、`look_again` → `black_red_diagonal_type`），新调用请使用规范枚举值。

### 角色表情包

同时注册 `character-emoji/v2`、`v3`、`v4`（无自动回退；切片路径 `/openapi/processes/character-emoji/{v2|v3|v4}.json`）。

- `v2` / `v3` 使用服务端内置角色库（`v2` 按角色去重，`v3` 支持同角色 `Chibi` + `Girl` 双版本登场；`Doubao` 仅支持 `Chibi`）。主用 Flare 渠道，主用失败时自动切换一次 Magikaru 备用（主动取消或总截止除外）。
- `v4` 由调用方传入完整阵容与不可变官方参考图 URL（拒绝重定向与非法路径）；已派发生图且结果未知时返回 `DEPENDENCY_FAILURE_AFTER_COMMIT` 并保留原运行身份核验，禁止重复发起付费任务。
- 文字策略：`idea` 明确禁止任何文字时优先级高于 `captionSetting`；`none` 仅关闭主台词、仍允许必要场景文字。
- **素材授权**：既有 AI-Fanworks 角色参考图采用 **CC BY-NC-SA 4.0**，仅供非商业验证，商用前须另行确认授权；豆包参考图单独记录来源。详见[角色表情包专题](processes/common/character-emoji/README.md)。

### 图片转模板

`template-from-image/v1`（输出运行语义 v2）与 `template-from-image/v2`（输出运行语义 v3，目标级 `appearance`/`pose` 与全局 `visualContract` 分离），切片见 `/openapi/processes/template-from-image/{v1|v2}.json`。单次上限 480 秒，服务端执行受控下载（禁私网与重定向，<= 20 MB / 30 秒，静态 PNG/JPEG/WebP）+ 编译 + 独立看图复核；不生图、不入库、不发布，`cover`/`referenceImage` 原样引用输入 URL。详见[图片转模板专题](processes/memebuy/template-from-image/README.md)。

### 印花拆解模板（Process v3）

`template-from-image/v3`（`/openapi/processes/template-from-image/v3.json`）：输出 `inputSchema.version = 2` 与 `runtimeSemantics.version = 4`（含 `designSpec`，无 `visualContract`），并加法附带可选 `source: { texts, condition }` 供下游母版生成核对。默认主体、文字与配色保留原图，`promptTemplate` 由服务端单向投影。单次上限 480 秒。详见[印花拆解候选](processes/memebuy/template-from-image/print-design-v4.md)。

### 模板单次修图（template-master/v2）

`template-master/v2`（`/openapi/processes/template-master/v2.json`）：单次预算 **360 秒**，推荐使用异步 `POST /process-runs`。面向显式单次 AI 修图，不做自动分档、多轮重试或 LLM 二次校验。

- **显式操作与原生透明**：接收 `imageUrl`、`operation`（`transparent_only` / `remove_watermark` / `extract_from_photo`）、`transparent`（`transparent_only` 模式下必须为 `true`）、可选 `watermarkNote`（最多 200 字，仅 `remove_watermark` 生效）与可选 `template`（v4 草稿子集；独立 MCP 场景可省略）。单次调用 `gpt-image-2.6-sunburst`（`quality: "medium"`，`background: transparent | opaque`），仅做确定性 PNG/尺寸与透明/可见像素校验后按内容寻址上传至模板公读存储。
- **失败与计费**：改图被明确拒绝返回 `502 DEPENDENCY_FAILURE`；已派发但结果未知或上传失败返回 `502 DEPENDENCY_FAILURE_AFTER_COMMIT`；未通过基础 PNG/透明校验返回 `502 MASTER_NOT_ACCEPTED`。付费派发后禁止自动重试。详见[模板母版专题](processes/memebuy/template-master/README.md)。

### 母版生成（template-master/v1）

`template-master/v1`（`/openapi/processes/template-master/v1.json`）：单次预算 **2400 秒**，必须使用异步 `POST /process-runs`。支持二选一输入：推荐传同 caller 的上游 `sourceRunId`（受理前校验并快照，非法返回 `400 SOURCE_RUN_*`、零费用且不占 `Idempotency-Key`），或兼容直传 `template + condition + sourceTexts?`。

- **跳档与轻档语义**：原图权威 `source.texts` / `sourceTexts` 与模板默认文字存在排版非等价冲突时，直接跳档重绘（不消耗尝试次数）；干净平面稿轻档直接交付原图、零模型调用；独立图形抠底未通过而保留原图背景交付时，返回 `master.backgroundKept: true` 且 `checks.printable.passed: false`。
- **失败与计费**：全部档位未过返回 `502 MASTER_NOT_ACCEPTED`，次数或已知费用用尽返回 `502 MASTER_BUDGET_EXHAUSTED`（文字失败时 `message` 附括号说明，未知费用不计入 `maxUsd`），付费后上传失败返回 `502 DEPENDENCY_FAILURE_AFTER_COMMIT`；以上均禁止自动重试。详见[模板母版专题](processes/memebuy/template-master/README.md)。

### 商品做同款（product-remix/v1）

`product-remix/v1`（`/openapi/processes/product-remix/v1.json`）：硬超时 **660 秒**，推荐使用异步 `POST /process-runs`。

- **单层基准与参考图**：`sourceImageUrl` 为唯一风格与版式基准；可选单张 `referenceImageUrl` 或 `0–9` 张有序 `referenceImageUrls`（二者互斥）。
- **成图 URL 三条硬红线**：`output.image.url` 必须直取 `200 OK` 无任何 3xx 重定向、满足公网原图 HTTPS URL 红线（无端口、凭据、`#hash`、IP/localhost、`x-oss-process`），且**严禁回显输入原图或参考图 URL**（失败或预算耗尽直接落 `failed`）。详见[商品做同款专题](processes/memebuy/product-remix/README.md)。

### Process：`composed-task`（`v1`）

`composed-task/v1`（`/openapi/processes/composed-task/v1.json`）：默认关闭，需显式配置 `COMPOSED_TASK_ENABLED=true`（未开启返回 `404 PROCESS_NOT_FOUND`）。服务端 Planner 在固定 allow-list（7 个流程，不含照片海报）和服务端预算（`COMPOSED_TASK_MAX_STEPS`、`COMPOSED_TASK_MAX_PRICED_STEPS`、`COMPOSED_TASK_TIMEOUT_MS`）内编排步骤，每步以 `<runId>.<step>` 作为下游幂等键。至少一个付费步骤成功但整体未完成时落 `DEPENDENCY_FAILURE_AFTER_COMMIT`，禁止自动重试。详见[组合任务专题](processes/common/composed-task/README.md)。

### 其他通用与新闻图片 Process

- `minimal-zine-poster/v1`（`/openapi/processes/minimal-zine-poster/v1.json`）：约 3:5 极简海报；详情见[极简海报专题](processes/common/minimal-zine-poster/README.md)。
- `crt-interface-image/v1`（`/openapi/processes/crt-interface-image/v1.json`）：返回 CRT 终图 `image` 与处理前模型原图 `rawImage`（保留 `rawImage` 可换 `grain` 重处理）；`sourceImageUrl` 原样交由 FAL 匿名读取。详见[CRT 专题](processes/common/crt-interface-image/README.md)。
- `news-image-narrative-monument/v1`、`news-image-pale-watercolor/v1`、`news-image-raw-humanism/v1`：固定 4:3 PNG（当前生产 1600×1200），风格由 `process` 固定，不接收 `style` 字段。详见[Memene 场景目录](processes/memene/README.md)。
