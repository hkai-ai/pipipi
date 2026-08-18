# 业务接口文档

本文面向业务调用方和调用 Agent，记录七个 Business Process 的请求、响应、重试与通知契约，以及临时开放的内部评测接口。场景列帮助产品找到契约；请求仍只提交准确 Process 和版本。

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
| 内部评测入口 | `POST /internal/eval/execute`；仅在部署方显式启用时可用 |
| Content-Type | `application/json` |
| 鉴权 | 应用不校验鉴权请求头；网关启用鉴权时，按网关要求携带凭证 |
| 字符编码 | UTF-8 |
| 请求体上限 | 当前应用上限为 262144 UTF-8 bytes；入口网关可以设置更小的限制 |
| 执行时限 | 当前 Process 上限为 240 秒；同步客户端应预留网络开销并使用至少 260 秒的读取超时 |
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
| `common` | `content-processing` | 处理一段业务文本 |
| `common` | `titled-content-processing` | 处理标题和正文 |
| `common` | `minimal-zine-poster` | 生成极简 Zine 海报 |
| `common` | `crt-interface-image` | 根据公网参考图生成 CRT 风格图片 |
| `memene` | `news-image-narrative-monument` | 生成人物叙事碑式新闻图片 |
| `memene` | `news-image-pale-watercolor` | 生成淡彩绘本新闻图片 |
| `memene` | `news-image-raw-humanism` | 生成原质人文主义新闻图片 |

Memebuy 当前没有已登记 Process。完整场景归属见 [Business Process 场景目录](processes/README.md)。

调用方不能提交 Skill、Prompt、模型、Tool、图片供应商或存储配置。新闻图片风格由 `process` 固定，接口不接收 `style` 字段。

## 内部新闻图片评测

`POST /internal/eval/execute` 临时向受控测试调用方开放。该接口只接受三个新闻图片 Process，并复用正式 `/execute` 的 Executor、Registration、Agent 和图片 Capability。一次请求只执行一次 Process。

部署方必须设置 `INTERNAL_EVAL_ENABLED=true` 才会挂载该路由。入口关闭时返回 HTTP `404` 和 `ROUTE_NOT_FOUND`。生产 Compose 固定关闭该入口。

该调用会访问文本模型、图片供应商和对象存储，产生费用和外部写入。应用目前不单独鉴权；部署方必须通过可信网关限制调用方。

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
| 502 | `DEPENDENCY_FAILURE_AFTER_COMMIT` | 图片已生成并计费，但后处理、存储或引用解析失败导致无法交付；重试会再次产生费用，不得自动重试 |
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
