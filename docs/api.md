# 业务接口文档

本文面向业务调用方，记录七个 Business Process 的请求和响应契约，以及临时开放的内部评测接口。

## 接入信息

| 项目 | 值 |
| --- | --- |
| Base URL | `https://pi.ganjiuwanshi.com` |
| 业务入口 | `POST /execute` |
| 内部评测入口 | `POST /internal/eval/execute`；仅在部署方显式启用时可用 |
| Content-Type | `application/json` |
| 鉴权 | 应用不校验鉴权请求头；网关启用鉴权时，按网关要求携带凭证 |
| 字符编码 | UTF-8 |
| `X-Request-Id` | 可选。调用方自己的 trace id，会写入本次请求的每一条运行日志，包括没有 `runId` 的传输层拒绝。限 1–200 个字符，字符集 `A-Za-z0-9_.:-`；不合规的取值被忽略，不影响执行，也不回显 |

请求使用严格 Schema。多余字段、错误类型、未知 Process 和未知版本都会被拒绝。

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

| process | 用途 |
| --- | --- |
| `content-processing` | 处理一段业务文本 |
| `titled-content-processing` | 处理标题和正文 |
| `minimal-zine-poster` | 生成极简 Zine 海报 |
| `crt-interface-image` | 根据公网参考图生成 CRT 风格图片 |
| `news-image-narrative-monument` | 生成人物叙事碑式新闻图片 |
| `news-image-pale-watercolor` | 生成淡彩绘本新闻图片 |
| `news-image-raw-humanism` | 生成原质人文主义新闻图片 |

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

可信网关先认证调用方，删除请求中的 `x-pipipi-caller-id` 与 `x-pipipi-gateway-token`，再注入稳定 caller subject 和服务端共享凭证。调用方不得直接构造这两个内部头。`Idempotency-Key` 必填、最长 512 bytes，并按已认证 caller 隔离；网络中断或响应丢失时，重试同一业务操作必须复用原 key。

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

调用方随后使用同一网关身份查询：

```http
GET /process-runs/c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c HTTP/1.1
Authorization: Bearer <same caller credential>
```

查询返回 `queued`、`running`、`succeeded` 或 `failed`。终态沿用同步接口的公开 `output` 或 `error` 结构；结果到期后返回 `resultAvailability: "expired"` 与 `resultExpiredAt`。非 owner 与未知 `runId` 都返回相同的 `404 PROCESS_RUN_NOT_FOUND`，不能据此枚举资源。

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
| 502 | `DEPENDENCY_FAILURE` | Business Capability、图片服务或存储服务不可用；失败发生在图片生成计费之前，重试不额外产生费用 |
| 502 | `DEPENDENCY_FAILURE_AFTER_COMMIT` | 图片已生成并计费，但后处理、存储或引用解析失败导致无法交付；重试会再次产生费用，不得自动重试 |
| 503 | `SERVICE_BUSY` | 同步执行容量已满；按 `Retry-After` 重试 |
| 504 | `PROCESS_TIMEOUT` | 执行超时 |

错误响应不会返回 Prompt、模型响应、凭证或内部异常正文。

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
