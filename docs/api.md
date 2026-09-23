# 业务接口文档

本文面向业务调用方和调用 Agent，记录十五个 Business Process（默认启用十四个）的请求、响应、重试与通知契约，以及临时开放的内部评测接口。场景列帮助产品找到契约；请求仍只提交准确 Process 和版本。

## Agent 读取入口

Agent 先读取 [`https://pi.ganjiuwanshi.com/llms.txt`](https://pi.ganjiuwanshi.com/llms.txt)，再按其中的链接读取本页的纯 Markdown 版本：[`https://pi.ganjiuwanshi.com/docs/api.md`](https://pi.ganjiuwanshi.com/docs/api.md)。兼容路径 `/llm.txt` 返回与 `/llms.txt` 相同的内容。

这两个入口只提供随当前应用版本发布的公开文档，不执行 Process，也不包含凭证、Prompt 或内部运行配置。

## 接入信息

| 项目 | 值 |
| --- | --- |
| Base URL | `https://pi.ganjiuwanshi.com` |
| Agent 入口 | `GET /llms.txt`；兼容 `GET /llm.txt` |
| 完整 Markdown | `GET /docs/api.md` |
| 业务入口 | `POST /execute` |
| 内部评测入口 | `POST /internal/eval/execute`；当前生产已开启 |
| Content-Type | `application/json` |
| 鉴权 | 应用不校验鉴权请求头；网关启用鉴权时，按网关要求携带凭证 |
| 字符编码 | UTF-8 |
| 请求体上限 | 当前应用上限为 262144 UTF-8 bytes；入口网关可以设置更小的限制 |
| 执行时限 | 图片转模板上限 480 秒，建议客户端读取超时至少 500 秒；其他 Process 上限 240 秒，建议至少 260 秒。网关超时也需相应配置 |
| `X-Request-Id` | 可选。调用方自己的 trace id，会写入本次请求的每一条运行日志，包括没有 `runId` 的传输层拒绝。限 1–200 个字符，字符集 `A-Za-z0-9_.:-`；不合规的取值被忽略，不影响执行，也不回显 |

请求使用严格 Schema。多余字段、错误类型、未知 Process 和未知版本都会被拒绝。

## 选择执行方式

| 方式 | 适用条件 | 重试边界 |
| --- | --- | --- |
| `POST /execute` | 调用方需要在同一个 HTTP 请求中等待结果 | 不提供调用方幂等键。网络超时不代表 Process 未执行；付费图片调用不得自动重试 |
| `POST /process-runs` | 异步入口已开放，或调用方需要可靠接受、轮询和安全重放 | 必须使用稳定的 `Idempotency-Key`；提交响应丢失时用同一 key 和同一请求重试 |

`X-Request-Id` 只用于排查请求，不提供幂等性。调用方需要安全重放时选择异步入口。

## 执行业务流程

```http
POST /execute HTTP/1.1
Host: pi.ganjiuwanshi.com
Content-Type: application/json
```

### 请求结构

```json
{
  "process": "news-image-pale-watercolor",
  "version": "v1",
  "input": {
    "title": "城市开始使用无人机巡检老旧桥梁",
    "summary": "首批巡检发现需要进一步检查的安全隐患。"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `process` | string | 是 | Business Process 标识，必须使用下表中的准确值 |
| `version` | string | 是 | Process 版本，当前均为 `v1` |
| `input` | object | 是 | Process 对应的业务输入 |

### Process 清单

| 场景 | process | 用途 |
| --- | --- | --- |
| `memebuy` | `template-from-image` | 从参考图编译可编辑模板草稿；对接 Memebuy 素材箱提取 Worker，保留 Pipipi 本地测试，尚未部署 |
| `common` | `content-processing` | 处理一段业务文本 |
| `common` | `titled-content-processing` | 处理标题和正文 |
| `common` | `minimal-zine-poster` | 生成极简 Zine 海报 |
| `common` | `photo-doodle-collage` | 生成摄影剪贴与互动黑线小人海报 |
| `common` | `crt-interface-image` | 根据公网参考图生成 CRT 风格图片 |
| `memene` | `news-image-narrative-monument` | 生成人物叙事碑式新闻图片 |
| `memene` | `news-image-pale-watercolor` | 生成淡彩绘本新闻图片 |
| `memene` | `news-image-raw-humanism` | 生成原质人文主义新闻图片 |
| `common` | `composed-task` | 由服务端 Planner 在预算内组合上述 Process 完成一个目标；部署默认关闭，未开启时返回 `PROCESS_NOT_FOUND` |

Memebuy 场景的图片转模板返回 Gallery v2 草稿，不直接写入 Memebuy。完整场景归属见 [Business Process 场景目录](processes/README.md)。

调用方不能提交 Skill、Prompt、模型、Tool、图片供应商或存储配置。新闻图片风格由 `process` 固定，接口不接收 `style` 字段。

## 图片转模板

`template-from-image/v1` 当前对接 Memebuy 素材箱提取 Worker，候选需人工确认后导入；尚未部署，真实页面验收另行完成。主 API 启动后通过统一的 `/execute` 调用。

```json
{
  "process": "template-from-image",
  "version": "v1",
  "input": {
    "imageUrl": "https://your-public-assets.example/reference.png",
    "note": "保留构图，让用户替换主角和文字"
  }
}
```

`imageUrl` 必填，公网 HTTPS、最多 2048 字符，无用户名密码。服务端下载一次，禁止私网和重定向，下载最多 20 MB / 30 秒；图片必须是静态 PNG/JPEG/WebP、宽高至少 64、最多 4000 万像素。`note` 可选，去首尾空格后 1–500 字符；它是编辑意图，不是运行配置。

地址保护或 DNS 解析失败仍返回 `DEPENDENCY_FAILURE`，错误说明会区分受限地址、DNS 问题和图片读取问题；不会回显原图 URL。这些失败均发生在模型调用前。

成功沿用统一响应壳：`{ runId, process, version, status: "succeeded", output: { template } }`。`template` 是完整 Gallery v2 对象：

| 字段 | 返回值与含义 |
| --- | --- |
| `key`、`title`、`description` | 建议玩法名、中文标题和说明；key 尚未做业务注册表去重 |
| `kind`、`status` | 固定 `PROMPT`、`DRAFT` |
| `cover`、`referenceImage` | 原样引用本次输入地址；不会转存，短期 URL 会到期 |
| `imageSize`、`imageN`、`preprocessSteps` | 根据原图比例选择固定尺寸；数量固定 1，预处理固定空数组 |
| `promptTemplate` | 带默认值占位符的模板内容；属于草稿业务输出，不包含内部编译 Prompt |
| `inputSchema` | version 2，1–4 个可选编辑槽位，每槽支持文字和三个推荐值；身份替换还支持私有图片输入 |
| `runtimeSemantics` | version 2，明确目标、输入绑定、身份替换策略、服装归属和视觉约束 |
| `metadata.tags` | 5–8 个发现标签，包含至少一个正式大类 |

Process 最长 480 秒，成功前进行 Schema 与语义校验，先生成分析和草稿，再独立看图复核并返回必要字段补丁，程序合并后统一校验。正常两次视觉模型调用；仅首轮 JSON 或候选结构无法读取时允许一次重新编译，最多三次，之后仍须独立复核。复核或补丁未通过校验则失败，不自动追加模型请求。不向调用方返回内部 analysis、review、图片字节、模型或 Skill 配置。不生成成品、不入库、不发布。JSON 结构正确不代表视觉理解已经人工确认。

已完成响应中的 JSON 语法错误与合同错误共用这一次修正预算。模型输入合同与服务端校验均将标题和描述限制为 20 字；单个多余末尾闭括号或 Markdown 包裹可被去除，但不补造草稿字段，且仍需完整校验。

错误沿用统一错误壳：非法输入为 `INVALID_INPUT`；图片获取或解码失败为 `DEPENDENCY_FAILURE`；模型不支持视觉、执行失败或两次候选校验失败为 `AGENT_FAILURE`；超时返回 `PROCESS_TIMEOUT`；取消沿用共享 Runner 的 `INTERNAL_ERROR`，已断开的客户端可能收不到响应。同步调用无调用方幂等保证，网络失败不自动重试；图像下载失败不会调用模型。鉴权沿用部署平台策略。

执行异常的提示区分编译、修正与复核阶段，并按可识别原因显示连接中断、限流、鉴权、超时或空响应；无法识别时只报告执行异常，不推定模型配置错误。调用方按错误码处理，不解析提示文案；原始异常、供应商地址和凭据不会返回。

## 内部新闻图片评测

`POST /internal/eval/execute` 临时向受控测试调用方开放。该接口只接受三个新闻图片 Process，并复用正式 `/execute` 的 Executor、Registration、Agent 和图片 Capability。一次请求只执行一次 Process。

部署方必须设置 `INTERNAL_EVAL_ENABLED=true` 才会挂载该路由。入口关闭时返回 HTTP `404` 和 `ROUTE_NOT_FOUND`。生产 Compose 目前开启该入口，供受控评测调用方直接访问。

该调用会访问文本模型、图片供应商和对象存储，产生费用和外部写入。该入口不做独立鉴权实现，与 `/execute` 保持同一鉴权姿态，鉴权后续与 `/execute` 一并统一处理。响应会投影本次执行实际使用的 Prompt 与文本模型。

请求结构与正式 `/execute` 相同：

```http
POST /internal/eval/execute HTTP/1.1
Host: pi.ganjiuwanshi.com
Content-Type: application/json
```

```json
{
  "process": "news-image-pale-watercolor",
  "version": "v1",
  "input": {
    "title": "城市开始使用无人机巡检老旧桥梁",
    "summary": "首批巡检发现需要进一步检查的安全隐患。"
  }
}
```

成功时返回 HTTP `200` 和 `Cache-Control: no-store`。`output.generation` 投影本次执行实际使用的 Prompt、文本模型和非敏感图片参数：

```json
{
  "runId": "35833107-f4c5-4baa-aca2-c6d5e15452a5",
  "process": "news-image-pale-watercolor",
  "version": "v1",
  "status": "succeeded",
  "output": {
    "style": "pale-watercolor",
    "image": {
      "url": "https://assets.example.com/news-images/35833107.png",
      "contentType": "image/png",
      "width": 1600,
      "height": 1200
    },
    "generation": {
      "prompt": "本次实际传入图片模型的完整 compiled.prompt",
      "promptModel": "gpt-5.4-mini",
      "imageProvider": "fal",
      "imageModel": "gpt-image-2",
      "aspectRatio": "4:3",
      "width": 1600,
      "height": 1200,
      "quality": "low",
      "outputFormat": "png",
      "numImages": 1,
      "seed": null,
      "otherParams": {
        "sync_mode": true
      }
    }
  }
}
```

`generation.prompt` 是校验后直接交给图片 Capability 的 `compiled.prompt`。其他字段来自本次 Capability 调用解析出的参数。诊断内容只进入该响应，不进入正式 `/execute` 输出、日志或 Run Record。

非新闻图片 Process 返回 HTTP `400` 和 `INVALID_INPUT`。Process 执行失败时沿用正式 `/execute` 的错误码和公开消息，不返回 `output.generation`。

## 异步执行

异步入口只在部署方完成发布门禁并通过可信网关开放后可用。调用方仍提交上节定义的同一个业务请求；不能提交 Queue、Worker、Skill、模型或运行配置。

```http
POST /process-runs HTTP/1.1
Authorization: Bearer <gateway credential>
Idempotency-Key: <caller-scoped key>
Content-Type: application/json
```

可信网关先认证调用方，删除请求中的 `x-pipipi-caller-id` 与 `x-pipipi-gateway-token`，再注入稳定 caller subject 和服务端共享凭证。调用方不得直接构造这两个内部头。`Idempotency-Key` 必填、最长 512 UTF-8 bytes，并按已认证 caller 隔离；网络中断或响应丢失时，重试同一业务操作必须复用原 key。

durable acceptance 成功返回 HTTP `202`、`Location: /process-runs/{runId}`、`Retry-After` 与不含业务结果的 Run：

```json
{
  "runId": "c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c",
  "process": "content-processing",
  "version": "v1",
  "status": "queued",
  "createdAt": "2026-08-14T10:00:00.000Z"
}
```

同一 caller、key 和规范化请求只创建一个 Run，并返回相同 `runId`。重放发生在 Run 已经开始或完成之后时，HTTP 仍为 `202`，但 `status` 会反映当时真实的 `running`、`succeeded` 或 `failed` 状态；调用方始终根据 `Location` 查询完整结果。同一个 key 配合不同请求返回 `409 IDEMPOTENCY_CONFLICT`。

调用方随后使用同一网关身份查询：

```http
GET /process-runs/c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c HTTP/1.1
Authorization: Bearer <same caller credential>
```

查询成功始终返回 HTTP `200` 和 `Cache-Control: no-store`。`queued` 与 `running` 响应还包含 `Retry-After`；调用方按该秒数等待后继续查询，不自行高频轮询：

```json
{
  "runId": "c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c",
  "process": "content-processing",
  "version": "v1",
  "status": "running",
  "createdAt": "2026-08-14T10:00:00.000Z",
  "startedAt": "2026-08-14T10:00:01.000Z"
}
```

终态成功增加 `finishedAt` 和对应 Process 的 `output`；终态失败也返回 HTTP `200`，并增加 `finishedAt` 和稳定 `error`。因此调用方必须判断 body 的 `status`，不能只判断 HTTP 状态：

```json
{
  "runId": "c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c",
  "process": "content-processing",
  "version": "v1",
  "status": "failed",
  "createdAt": "2026-08-14T10:00:00.000Z",
  "startedAt": "2026-08-14T10:00:01.000Z",
  "finishedAt": "2026-08-14T10:00:02.000Z",
  "error": {
    "code": "DEPENDENCY_FAILURE",
    "message": "A required business service is unavailable"
  }
}
```

结果内容到期后仍保留真实终态和时间，但用以下字段替代 `output` 或 `error`：

```json
{
  "runId": "c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c",
  "process": "content-processing",
  "version": "v1",
  "status": "succeeded",
  "createdAt": "2026-08-14T10:00:00.000Z",
  "startedAt": "2026-08-14T10:00:01.000Z",
  "finishedAt": "2026-08-14T10:00:02.000Z",
  "resultAvailability": "expired",
  "resultExpiredAt": "2026-08-21T10:00:02.000Z"
}
```

非 owner 与未知 `runId` 都返回相同的 `404 PROCESS_RUN_NOT_FOUND`，不能据此枚举资源。初始版本不支持取消或 Run 列表查询。

| HTTP 状态 | error.code | 说明 |
| ---: | --- | --- |
| 400 | `IDEMPOTENCY_KEY_REQUIRED`、`INVALID_IDEMPOTENCY_KEY` | 幂等键缺失或无效 |
| 401 | `CALLER_UNAUTHORIZED` | 可信网关身份缺失或无效 |
| 404 | `PROCESS_RUN_NOT_FOUND` | 未知或不属于当前 caller 的 Run |
| 409 | `IDEMPOTENCY_CONFLICT` | 同一 caller/key 已绑定不同请求 |
| 429 | `CALLER_BACKLOG_LIMIT_REACHED` | caller backlog 已满；等待 `Retry-After`，继续查询已接受 Run |
| 503 | `ASYNC_SERVICE_CAPACITY_REACHED` | 全局 backlog 已满 |
| 503 | `ASYNC_SERVICE_UNAVAILABLE` | 异步依赖暂时不可用 |
| 503 | `ASYNC_INTAKE_CLOSED` | 运维已关闭新异步提交；同步 `/execute` 与既有 owner GET 仍可用 |

## Webhook 通知

异步入口开放且调用方已由服务端预注册 Webhook Endpoint 时，服务发送 `process_run.succeeded` 或 `process_run.failed` 终态事件。当前没有公开的 Endpoint 注册 API；产品请求也不能携带 Webhook URL。

```json
{
  "schemaVersion": 1,
  "eventId": "d52b4d30-3bfd-4c73-b0bc-e4c67fd97aa1",
  "type": "process_run.succeeded",
  "createdAt": "2026-08-14T10:00:02.000Z",
  "data": {
    "runId": "c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c",
    "process": "content-processing",
    "version": "v1",
    "status": "succeeded",
    "resultLocation": "/process-runs/c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c"
  }
}
```

Webhook 只通知终态，不携带业务输入、输出或内部错误。接收方验证签名后，使用与 Run owner 相同的网关身份读取 `data.resultLocation`。

每次请求包含以下 Standard Webhooks 风格的头：

| Header | 内容 |
| --- | --- |
| `webhook-id` | `eventId`；同一事件重试时保持不变 |
| `webhook-timestamp` | 签名时的 Unix 秒时间戳 |
| `webhook-signature` | 一个或两个以空格分隔的 `v1,<base64-hmac>`；两个签名表示 Secret 正在轮换 |

验签时保留收到的原始请求 body，不要先解析再重新序列化。移除 Secret 的 `whsec_` 前缀并 Base64 解码得到 HMAC key，然后计算：

```text
signed = webhook-id + "." + webhook-timestamp + "." + raw-request-body
expected = "v1," + base64(HMAC-SHA256(key, signed))
```

使用常量时间比较任一 `v1` 签名，并拒绝超出接收方允许时间偏差的时间戳。接收方按 `eventId` 幂等处理，只在事件已可靠保存后返回 `2xx`。

Webhook 是至少一次投递，不保证跨 Run 的全局顺序。网络错误、超时、`429` 和 `5xx` 会重试；`3xx` 不跟随，`410` 会停用 Endpoint。重复或延迟通知不改变 Run 的权威状态。

## Process 契约

### Process：`content-processing`（`v1`）

完整请求 body：

```json
{
  "process": "content-processing",
  "version": "v1",
  "input": {
    "content": "整理这段业务内容"
  }
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `content` | string | 是 | 去除首尾空白后不能为空 |

响应 `output`：

```json
{
  "content": "已处理的业务内容"
}
```

### Process：`titled-content-processing`（`v1`）

完整请求 body：

```json
{
  "process": "titled-content-processing",
  "version": "v1",
  "input": {
    "title": "季度业务简报",
    "body": "整理这段带标题的业务内容"
  }
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `title` | string | 是 | 去除首尾空白后不能为空 |
| `body` | string | 是 | 去除首尾空白后不能为空 |

响应 `output`：

```json
{
  "title": "季度业务简报",
  "content": "已处理的业务内容"
}
```

### Process：`minimal-zine-poster`（`v1`）

完整请求 body：

```json
{
  "process": "minimal-zine-poster",
  "version": "v1",
  "input": {
    "brief": "为雨天旧书店制作一张安静的海报",
    "text": "RAINY BOOKS"
  }
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `brief` | string | 是 | 去除首尾空白后为 1–12000 个字符 |
| `text` | string | 否 | 去除首尾空白后为 1–80 个字符 |

响应 `output`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `prompt` | string | 服务端生成的绘图 Prompt |
| `recipe` | object | 包含 `layout`、`anchor`、`typography`、`accent`、`texture` 和 `mood` |
| `interpretation` | string | 对业务 brief 的视觉解释 |
| `image` | object | 生成的约 3:5 图片，结构见[图片对象](#图片对象) |

### Process：`crt-interface-image`（`v1`）

完整请求 body：

```json
{
  "process": "crt-interface-image",
  "version": "v1",
  "input": {
    "sourceImageUrl": "https://assets.example.com/source.png",
    "palette": "经典",
    "aspectRatio": "4:3",
    "grain": "normal"
  }
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `sourceImageUrl` | string | 是 | FAL 可匿名读取的公网 HTTPS URL，最长 2048 个字符；不接受 IP、端口、片段或认证信息 |
| `palette` | string | 是 | `经典`、`粉黛`、`极客01`、`极客02`、`复古01`、`复古02`、`游戏01`、`游戏02` 或 `如图` |
| `aspectRatio` | string | 是 | `3:4`、`4:3`、`9:16` 或 `16:9` |
| `grain` | string | 否 | 像素颗粒度 `fine`、`normal` 或 `coarse`，缺省 `normal`；`normal` 与未引入该字段时的输出字节级一致 |

响应 `output`：

```json
{
  "aspectRatio": "4:3",
  "image": {
    "url": "https://assets.example.com/crt/result/run.png",
    "contentType": "image/png",
    "width": 1600,
    "height": 1200
  },
  "rawImage": {
    "url": "https://assets.example.com/crt/raw/run.png",
    "contentType": "image/png",
    "width": 1600,
    "height": 1200
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `image` | CRT 处理后的最终产物，结构见[图片对象](#图片对象) |
| `rawImage` | CRT 处理**之前**的模型原图。保留它即可在之后换一个 `grain` 重新出图而不必再次调用模型；它使用供应商返回的栅格格式，尺寸不受 CRT 输出约束 |

两者写入不同的对象前缀（`result/` 与 `raw/`），便于分别配置生命周期规则。

服务端把 `sourceImageUrl` 原样交给 FAL。图片来源不能依赖 Cookie、内网地址或本机服务。

### 新闻图片 Process（`v1`）

以下三个 Process 使用相同的请求结构：

| process | `output.style` | 图片风格 |
| --- | --- | --- |
| `news-image-narrative-monument` | `narrative-monument` | 人物叙事碑式 |
| `news-image-pale-watercolor` | `pale-watercolor` | 淡彩绘本 |
| `news-image-raw-humanism` | `raw-humanism` | 原质人文主义 |

完整请求 body（以下示例使用淡彩绘本）：

```json
{
  "process": "news-image-pale-watercolor",
  "version": "v1",
  "input": {
    "title": "城市开始使用无人机巡检老旧桥梁",
    "summary": "首批巡检覆盖多座桥梁，并发现需要进一步检查的安全隐患。"
  }
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `title` | string | 是 | 去除首尾空白后为 1–300 个字符 |
| `summary` | string | 是 | 去除首尾空白后为 1–12000 个字符 |

响应 `output`：

```json
{
  "style": "pale-watercolor",
  "image": {
    "url": "https://assets.example.com/news-image/result.png",
    "contentType": "image/png",
    "width": 1600,
    "height": 1200
  }
}
```

新闻图片固定为 4:3 PNG；当前生产图片服务输出 1600×1200。

### Process：`composed-task`（`v1`）

部署显式设置 `COMPOSED_TASK_ENABLED=true` 后才可调用。完整请求 body：

```json
{
  "process": "composed-task",
  "version": "v1",
  "input": {
    "goal": "把这段介绍精简后做一张极简 zine 海报",
    "material": {
      "copy": "雨天的旧书店，安静、缓慢，适合长时间停留。"
    },
    "constraints": {
      "maxSteps": 3
    }
  }
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `goal` | string | 是 | 去除首尾空白后为 1–4000 个字符的自然语言目标 |
| `material` | object | 否 | 至多 16 个条目；键匹配 `^[a-z][a-zA-Z0-9]{0,31}$`，值为 1–12000 个字符的字符串。这是 Planner 能转交给各步骤的全部业务素材 |
| `constraints.maxSteps` | integer | 否 | 1–8，只能收紧服务端上限，不能放宽 |

调用方不能指定步骤、Process 顺序、Skill、模型或 Tool。服务端 Planner 从固定 allow-list（七个 Process，不含照片海报）中选择步骤，每个步骤仍按该 Process 自己的输入契约校验，并受服务端 `COMPOSED_TASK_MAX_STEPS`（默认 6）与 `COMPOSED_TASK_MAX_PRICED_STEPS`（默认 2，限制成功的图片步骤数）约束。

响应 `output`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `summary` | string | Planner 对所做步骤的一两句说明 |
| `steps` | array | 按执行顺序列出全部步骤，包括失败的；每项含 `step`、`process`、`version`、`status`，成功时带该 Process 的 `output`，失败时带 `error.code` 与 `error.message` |
| `result` | JSON | 逐字取自成功步骤输出的值：某个步骤的完整 `output`、其中一个子值，或由这类子值组成的平铺对象 |

部分步骤失败而 Planner 合理收尾时仍返回 `succeeded`，失败信息保留在 `steps` 中。`steps` 里的图片步骤输出沿用[图片对象](#图片对象)。

该 Process 专属的失败语义：

| error.code | 条件 |
| --- | --- |
| `AGENT_FAILURE` | Planner 未运行任何成功步骤、输出无法解析，或 `result` 不是逐字取自成功步骤 |
| `DEPENDENCY_FAILURE` | 运行过的步骤全部因业务服务不可用失败，且没有任何付费步骤成功 |
| `DEPENDENCY_FAILURE_AFTER_COMMIT` | 至少一个付费图片步骤已成功，但 Planner 之后失败、超时或输出无效；已产生费用，不得自动重试 |
| `PROCESS_TIMEOUT` | 整个 Run 超过 `COMPOSED_TASK_TIMEOUT_MS`（默认 600000 毫秒）；进行中的步骤一并取消 |

一次调用可能触发多次付费图片生成，费用上限由服务端 `COMPOSED_TASK_MAX_PRICED_STEPS` 决定。同一 Run 的每个步骤以 `<runId>.<step>` 作为下游幂等键。

## 成功响应

接口成功时返回 HTTP `200`：

```json
{
  "runId": "c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c",
  "process": "news-image-pale-watercolor",
  "version": "v1",
  "status": "succeeded",
  "output": {
    "style": "pale-watercolor",
    "image": {
      "url": "https://assets.example.com/news-image/result.png",
      "contentType": "image/png",
      "width": 1600,
      "height": 1200
    }
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `runId` | string | 本次执行的唯一标识；排查问题时提供此值 |
| `process` | string | 实际执行的 Process |
| `version` | string | 实际执行的版本 |
| `status` | string | 成功时固定为 `succeeded` |
| `output` | object | Process 对应的输出 |

## 图片对象

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 可访问的 HTTP(S) 图片地址 |
| `contentType` | string | 是 | 海报支持 PNG、JPEG、WebP；CRT 和新闻图片固定为 `image/png` |
| `width` | integer | 是 | 图片宽度，单位为像素 |
| `height` | integer | 是 | 图片高度，单位为像素 |
| `expiresAt` | string | 否 | 临时 URL 的 ISO 8601 失效时间 |

调用方直接使用 `url`，不要自行拼接对象存储路径。

## 失败响应

Process 执行失败时，响应包含 `runId`：

```json
{
  "runId": "c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c",
  "process": "news-image-pale-watercolor",
  "version": "v1",
  "status": "failed",
  "error": {
    "code": "INVALID_INPUT",
    "message": "The process input is invalid"
  }
}
```

HTTP 层在执行前拒绝请求时，不返回 `runId`：

```json
{
  "status": "failed",
  "error": {
    "code": "UNSUPPORTED_MEDIA_TYPE",
    "message": "Content-Type must be application/json"
  }
}
```

| HTTP 状态 | error.code | 说明 |
| ---: | --- | --- |
| 400 | `INVALID_INPUT` | JSON 结构或 Process 输入无效 |
| 404 | `PROCESS_NOT_FOUND` | Process 或版本不存在 |
| 413 | `REQUEST_TOO_LARGE` | 请求体超过服务端限制 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `Content-Type` 不是 JSON |
| 500 | `INVALID_OUTPUT` | Process 输出不符合契约 |
| 500 | `INTERNAL_ERROR` | 服务端发生内部错误 |
| 502 | `AGENT_FAILURE` | Agent 未能完成任务 |
| 502 | `DEPENDENCY_FAILURE` | Business Capability、图片服务或存储服务不可用；是否已经产生外部副作用取决于 Process，付费图片调用不得据此自动重试 |
| 502 | `DEPENDENCY_FAILURE_AFTER_COMMIT` | 图片已生成并计费，但后处理、存储或引用解析失败导致无法交付；`composed-task` 中指付费步骤已成功而 Run 未能完成。重试会再次产生费用，不得自动重试 |
| 503 | `SERVICE_BUSY` | 同步执行容量已满；按 `Retry-After` 重试 |
| 504 | `PROCESS_TIMEOUT` | 执行超时 |

错误响应不会返回 Prompt、模型响应、凭证或内部异常正文。

## 重试判断

| 结果 | 调用方动作 |
| --- | --- |
| 异步提交没有返回 `runId`，或返回 `429`、`503` | 等待 `Retry-After`，使用同一个 `Idempotency-Key` 和完全相同的请求重试 |
| 异步提交响应丢失或客户端超时 | 使用同一个 `Idempotency-Key` 和完全相同的请求重试；不得生成新 key |
| 异步 GET 返回 `503` | 等待 `Retry-After` 后安全重试同一个 GET |
| 同步 `/execute` 在执行前返回 `SERVICE_BUSY` | 等待 `Retry-After` 后可以重试 |
| 同步调用返回 `INVALID_INPUT`、`PROCESS_NOT_FOUND` 或其他确定性 `4xx` | 修正请求后再调用 |
| 同步调用网络超时、连接中断、`PROCESS_TIMEOUT` 或 `DEPENDENCY_FAILURE` | 执行和外部副作用可能已经发生。先按 `X-Request-Id` 联系服务方排查；付费图片 Process 不自动重试 |
| `DEPENDENCY_FAILURE_AFTER_COMMIT` | 已越过计费或外部提交点，不自动重试 |

同步入口每次接受请求都会创建新的 `runId`，没有调用方幂等保证。异步入口的幂等保证只作用于同一已认证 caller、同一个 key 和同一个规范化请求。

## 调用示例

curl：

```bash
curl -X POST 'https://pi.ganjiuwanshi.com/execute' \
  -H 'content-type: application/json' \
  -d '{
    "process": "news-image-pale-watercolor",
    "version": "v1",
    "input": {
      "title": "城市开始使用无人机巡检老旧桥梁",
      "summary": "首批巡检发现需要进一步检查的安全隐患。"
    }
  }'
```

PowerShell：

```powershell
$body = @{
    process = "news-image-pale-watercolor"
    version = "v1"
    input = @{
        title = "城市开始使用无人机巡检老旧桥梁"
        summary = "首批巡检发现需要进一步检查的安全隐患。"
    }
} | ConvertTo-Json -Depth 4

Invoke-RestMethod `
    -Uri "https://pi.ganjiuwanshi.com/execute" `
    -Method Post `
    -ContentType "application/json" `
    -Body $body
```

异步提交与轮询：

```bash
idempotency_key='replace-with-one-stable-operation-id'

curl --include --request POST 'https://pi.ganjiuwanshi.com/process-runs' \
  --header 'authorization: Bearer replace-with-gateway-credential' \
  --header "idempotency-key: ${idempotency_key}" \
  --header 'content-type: application/json' \
  --data '{
    "process": "content-processing",
    "version": "v1",
    "input": { "content": "整理这段业务内容" }
  }'

curl --include \
  --header 'authorization: Bearer replace-with-the-same-caller-credential' \
  'https://pi.ganjiuwanshi.com/process-runs/replace-with-run-id'
```

JavaScript 同步调用：

```javascript
const response = await fetch("https://pi.ganjiuwanshi.com/execute", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-request-id": crypto.randomUUID(),
  },
  body: JSON.stringify({
    process: "content-processing",
    version: "v1",
    input: { content: "整理这段业务内容" },
  }),
  signal: AbortSignal.timeout(260_000),
});

const result = await response.json();
if (!response.ok || result.status !== "succeeded") {
  throw new Error(`${result.error?.code ?? response.status}: request failed`);
}
```

## 图片背景参数

CRT 与七个照片海报的 `v1` 接受可选 `background: auto | transparent | opaque`；省略时保留原行为。背景参数直接传给模型，不追加或改写提示词；CRT 后处理同步变换 alpha。透明成品必须同时存在可见与透明像素；不符合时失败且不自动重绘。该参数进入下游幂等摘要，不能用同一个键切换背景。发布时先部署 Pipipi，再开放 Memebuy 能力声明；本地验证不代表生产已生效。

例如：`{"process":"woodcut-photo-poster","version":"v1","input":{"sourceImageUrl":"https://assets.example.com/photo.png","background":"transparent"}}`。其他 Process 未开放该字段。FAL 参数取值依据 [GPT Image 2 编辑接口](https://fal.ai/models/openai/gpt-image-2/edit/api)。

## 照片海报

以下七个 Process 均使用 `POST /execute`，版本固定为 `v1`。每次处理一张照片；批量由调用方逐张提交，不能上传流程、Skill、模型或运行参数。

| process | style | 输出规格 |
| --- | --- | --- |
| `dopamine-photo-poster` | `dopamine` | 1200×1600 PNG |
| `mono-color-photo-poster` | `mono-color` | 1200×1600 PNG |
| `travel-abstraction-photo-poster` | `travel-abstraction` | 1200×1600 PNG |
| `crayon-photo-poster` | `crayon` | 1200×1600 PNG |
| `monochrome-photo-poster` | `monochrome` | 1200×1600 PNG |
| `woodcut-photo-poster` | `woodcut` | 1200×1600 PNG |
| `photo-doodle-collage` | `photo-doodle-collage` | 1200×1600 PNG |

除旅行抽象外，input 为 `{ sourceImageUrl, text? }`。sourceImageUrl 必须为公网 HTTPS URL（最大 2048 字符，无凭据、片段、自定义端口或 IP 字面量）；text 为 1–200 字符的海报原文，不参与模型或风格选择。

### Mono Color 可编辑预设

`mono-color-photo-poster/v1` 在上述输入之外接受以下可选业务参数。旧请求不传这些参数时，保持 Skill 自动搭配。只要提供设计参数而未指定 `preset`，基于 `blue_orange_overlap` 补齐默认值。显式设置优先于预设；`preset` 字符串作为调整项的值时表示跟随当前预设。

| 字段 | 允许值 |
| --- | --- |
| `preset` | `blue_orange_overlap`（蓝橙穿字）、`blue_orange_diagonal_crop`（蓝橙斜切）、`black_red_statement`（黑红宣言）、`black_red_frame`（黑红取景框）、`black_red_diagonal_type`（黑红斜排） |
| `palette` | `preset`、`cobalt_terracotta`、`charcoal_red`、`green_oxblood` |
| `typography` | `preset`、`literary`、`condensed` |
| `composition` | `preset`、`editorial_cover`、`diagonal_crop`、`statement`、`frame`、`diagonal_type` |
| `emphasis` | `preset`、`gentle`、`balanced`、`bold` |
| `texture` | `preset`、`light`、`standard`、`strong` |
| `designNotes` | 1–500 字符的设计偏好；不覆盖结构化设置、主体保持、文字和输出规则 |

```json
{"process":"mono-color-photo-poster","version":"v1","input":{"sourceImageUrl":"https://assets.example.com/photo.png","preset":"blue_orange_diagonal_crop","palette":"charcoal_red","typography":"preset","text":"MY CAT","designNotes":"注释放左下角"}}
```

五个预设的默认设计如下；标题占比随 `emphasis` 调整，用户原文优先于分行要求，单词或长文案会适应版式，不补词或删词。

| 预设 | 标题与版式 |
| --- | --- |
| `blue_orange_overlap` | 蓝色衬线大标题分两行占下部约 35–45%，与原有主体轮廓穿插，橙色仅点缀主体细节 |
| `blue_orange_diagonal_crop` | 上部蓝色主标题与斜向裁切边界结合，短引导词可用橙色，露出主体焦点 |
| `black_red_statement` | 炭黑大标题在下部紧密堆叠两行、约占 35–45%，红色点缀现有主体细节，不退化成底部单行字幕 |
| `black_red_frame` | 上部较小红色标题、下部更大炭黑标题围合主体；仅保留原图已有的取景手势 |
| `black_red_diagonal_type` | 炭黑两行大字从左下向中部上扬，与右侧主体穿插，深色交叠处留纸白轮廓，红色局部点缀 |

五个预设默认使用接近白色的干净纸底、阴影细网点和清晰轮廓，不强制泛黄、粗网点或动漫化。线稿和阴影使用主色，背景留白，不铺大块辅色底板。显式覆盖配色或版式后，标题颜色分工跟随最终解析的配色与版式；显式 `texture: "strong"` 仍可使用粗网点。设计规则在编译前传入，并在最终图片指令中覆盖通用 Skill 的复古印刷要求。

旧 `preset` 值仍兼容：`within_reach` → `blue_orange_overlap`、`half_hidden` → `blue_orange_diagonal_crop`、`your_move` → `black_red_statement`、`hold_still` → `black_red_frame`、`look_again` → `black_red_diagonal_type`。只在输入校验时转换，复用相同设计规则；新调用使用新标识，Process 仍为 `v1`。

五个预设来自样图的设计归纳，不是作者公开的精确配方。它们调整版式和印刷处理，保留输入图主体、数量、动作及核心关系；不会为匹配示例额外制造伸手或手势。`text` 留空时按实际参考图提炼短英文，不把预设名印在画面上。只返回单张 1200×1600 PNG，不提供可编辑图层。其他五种照片 Process 不接受这些新增字段。

### 其他照片海报示例

```json
{"process":"dopamine-photo-poster","version":"v1","input":{"sourceImageUrl":"https://assets.example.com/photo.png","text":"SUMMER DAYS"}}
```

摄影剪贴与涂鸦小人示例：

```json
{"process":"photo-doodle-collage","version":"v1","input":{"sourceImageUrl":"https://assets.example.com/photo.png","text":"don't let go."}}
```

旅行抽象 input 为 `{ sourceImageUrl, phrase, archiveNumber?, capturedOn? }`。phrase 是用户根据照片提供的 1–3 个大写英文单词，最多 60 字符；archiveNumber 为 1–999，默认 1，无跨请求计数；capturedOn 为 YYYY-MM-DD，缺省采用服务端 UTC 创建日期，不猜测拍摄日期。

```json
{"process":"travel-abstraction-photo-poster","version":"v1","input":{"sourceImageUrl":"https://assets.example.com/photo.png","phrase":"QUIET PAWS","archiveNumber":1,"capturedOn":"2026-09-07"}}
```

成功 output 为 `{ style, image: { url, contentType: "image/png", width, height, expiresAt? } }`。正式输出不返回 Prompt、原图 URL、模型、Skill、供应商或存储配置。六项输出均为独立风格化成品，不附原照片、不分上下对照。旅行抽象的档案字样直接绘制在抽象成品上。

输入或额外字段不合法返回 INVALID_INPUT；版本不匹配返回 PROCESS_NOT_FOUND；编译失败返回 AGENT_FAILURE；明确未发起图片调用时失败返回 DEPENDENCY_FAILURE；已发出图片调用、响应丢失、保存失败或内部 pending 返回 DEPENDENCY_FAILURE_AFTER_COMMIT。禁止对后者自动重试，先核对执行记录。Process 超时仍按统一 PROCESS_TIMEOUT 契约处理，图片费用可能已产生。

内部图片服务 `POST /photo-posters` 是受控 Capability 协议，不供产品直连；使用 `CRT_BUSINESS_API_BASE_URL`，连接超时由服务端 `PHOTO_POSTER_API_TIMEOUT_MS` 配置，默认 180000 ms。

## 模板图片生产与两次审核

以下三个固定 Process 仅供受信任的 Memebuy 后台调用，均使用既有 `/execute` 或 `/process-runs` Interface。不得向普通用户开放可自行填写 reviewerRef 的调用入口。Process 身份、模型、Skill、存储与执行指令均由服务端固定；浏览器只提交候选 ID、当前摘要和审核决定。

| Process / version | input | output | Process 预算 |
| --- | --- | --- | --- |
| `template-image-plan/v1` | `{ imageUrl, note? }`，沿用原图片编译输入限制 | `{ productionId, sourceImageSha256, strategySha256, strategy }` | 240 秒 |
| `template-image-render/v1` | `{ productionId, objectSha256, reviewerRef }`，objectSha256 为方案摘要 | `{ productionId, imageSha256, reviewPackageSha256, width, height, imageDataUrl }` | 270 秒 |
| `template-from-source/v1` | `{ productionId, objectSha256, reviewPackageSha256, reviewerRef, note? }`，objectSha256 为成图摘要，note 为本轮模板编译要求 | `{ template, coverImageUrl, preparedImage }` | 570 秒 |

模板内容不满意时，调用方可用原成图审批发起新的编译轮次，并提交可选 `note`（去首尾空白后 1–500 字符）。新要求只覆盖本次编译的备注，不修改方案、生图指令或成图批准；省略时沿用原方案备注。已经上传的审核图片复用内容寻址对象，不重新生图或上传，返回的图片摘要保持不变。新轮次仍须人工审阅模板草稿；异步调用使用新轮次的幂等键，技术失败恢复沿用原运行。

方案校验失败时可在原 240 秒预算内进行一次受限字段修正，仍不通过则返回 `AGENT_FAILURE`；不会自动生图或批准方案。

productionId 为 UUID；摘要为小写 64 位 SHA-256；reviewerRef 为 1–191 字符的服务端审核者引用。字段闭合，不接受额外运行配置。strategy 是待人审阅的完整业务方案，包含替换目标、类别判断、组件分组、依赖与特征权限、文字/标记动作、冻结项、风险；准确结构由 `GET /processes` 的输出 Schema 给出，调用方不能用策略正文替代已持久化 productionId。新输出另含 execution：`{ version: "v2", prompt, promptSha256 }`，精确十二段指令由服务端从策略生成，与源图及策略一起纳入 strategySha256。原审批入参保持不变。

targetCanvas 增加 carrierRole（none/apparel/device/mechanism）、reason、excludedScopes；frozenSet 改为 `{ scope: "design" | "carrier" | "environment", regionId, instruction }[]`；文字项增加 originalText、componentId，exactText 表示最终文字，删除为空串。replacementComponentIds 关联闭包中实际替换的组件。审核端应展示这些业务要求，旧记录缺失字段标记“未记录”。完整场景需显示依据并显式勾选确认。

已保存的旧方案不自动转换：尚未提交生成的方案必须重新规划和确认；已知 requestId 继续恢复，已有成图继续原审批。明确拒绝、未知提交和需要重新批准的提示沿用现有公开错误分类。明确非重试 4xx 不恢复批准；未知提交禁止重投。

imageDataUrl 是完整 PNG 的 Base64 Data URL，原 PNG 至多 20,000,000 字节，整个成图审核输出至多 28,000,000 字节。该特例只属于固定 render Registration，其他输出仍受默认上限约束。审核方必须保存交接结果并等待人工批准，不因收到图片而自动调用下一步。

preparedImage 为 `{ url, sha256, width, height, contentType: "image/png" }`；url 固定为 `https://assets.memebuy.cn/gallery/template-images/<sha256>.png`。template.cover、template.referenceImage 和 coverImageUrl 均引用该图片。公开输出不包含原始策略、两次审批或业务备注。

方案失败返回 `AGENT_FAILURE`；生图或上传编译不能确定完成时返回 `DEPENDENCY_FAILURE_AFTER_COMMIT`。这些错误不授权重新付费生图：人工恢复必须提交原 productionId 与原批准摘要。已知供应商请求继续查询，未知生成提交需要对账。重试编译可能重新调用编译模型，但不会再生成图片。

## 可重复制作与成图版本

Memebuy 分步工作台可保留同一替换方案反复生图。`template-image-render/v1` 兼容可选 UUID `renderId`；同一 `productionId + renderId` 恢复原成图，不同 `renderId` 表示人工明确的新生图。缺省保持旧单图语义。成图审核包摘要包含 `renderId`，`template-from-source/v1` 的图片审批须原样携带该字段，不能跨版本采用审批。每个成图独立保留 attempt、图片、审核与上传记录，提交未知时复用原身份仍禁止重投。模板重编译继续复用同一图片和审批，返回新候选；草稿身份、版本、采用和真实测试由 Memebuy 管理。

先发布支持此字段的 Pi API 与内部图片 Business API，再发布 Memebuy Web 和 Worker；旧方案与旧成图文件原样兼容。
