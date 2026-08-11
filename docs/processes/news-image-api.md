# 新闻图片接口

三个新闻图片流程共用同步入口 `POST /execute`。调用方通过 `process` 选择固定风格；请求不能提交 Skill、Prompt、模型、供应商或 OSS 配置。

## 接口地址

```http
POST <BASE_URL>/execute
Content-Type: application/json
```

当前生产域名可使用：

```text
https://pi.ganjiuwanshi.com
```

若网关启用了鉴权，调用方还需携带网关约定的鉴权请求头。应用层接口本身只要求 JSON。

## 可用流程

| process | version | 风格 | 输出尺寸 |
| --- | --- | --- | --- |
| `news-image-narrative-monument` | `v1` | 人物叙事碑式 | 1600×1200 PNG |
| `news-image-pale-watercolor` | `v1` | 淡彩绘本 | 1600×1200 PNG |
| `news-image-raw-humanism` | `v1` | 原质人文主义 | 1600×1200 PNG |

调用方必须提交准确的 `process` 和 `version`。接口没有 `style` 入参；每个 Process 已在服务端绑定对应的 Runtime Skill。

## 请求参数

```json
{
  "process": "news-image-pale-watercolor",
  "version": "v1",
  "input": {
    "title": "某城市开始使用无人机巡检老旧桥梁",
    "summary": "首批巡检覆盖多座老旧桥梁，并发现12处需要进一步检查的安全隐患。"
  }
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `process` | string | 是 | 使用上表中的准确名称 |
| `version` | string | 是 | 当前固定为 `v1` |
| `input.title` | string | 是 | 去除首尾空白后为 1–300 个字符 |
| `input.summary` | string | 是 | 去除首尾空白后为 1–12000 个字符 |

请求采用严格 Schema。多余字段、空标题、空摘要、错误 Process 或错误版本都会被拒绝。

## 成功响应

接口成功时返回 HTTP `200`：

```json
{
  "runId": "76c75932-7a61-47d7-b4fd-44fb493e9005",
  "process": "news-image-pale-watercolor",
  "version": "v1",
  "status": "succeeded",
  "output": {
    "style": "pale-watercolor",
    "image": {
      "url": "https://assets.memebuy.cn/news-image/pale-watercolor/76c75932-7a61-47d7-b4fd-44fb493e9005.png",
      "contentType": "image/png",
      "width": 1600,
      "height": 1200
    }
  }
}
```

`image.url` 是可访问的 HTTP(S) 图片地址。签名 URL 还会包含 ISO 8601 格式的 `expiresAt`。调用方不应拼接 OSS 对象路径。

三个流程对应的 `output.style`：

| process | output.style |
| --- | --- |
| `news-image-narrative-monument` | `narrative-monument` |
| `news-image-pale-watercolor` | `pale-watercolor` |
| `news-image-raw-humanism` | `raw-humanism` |

## 失败响应

失败响应包含公开错误码，不返回 Prompt、供应商响应或内部异常：

```json
{
  "runId": "76c75932-7a61-47d7-b4fd-44fb493e9005",
  "process": "news-image-pale-watercolor",
  "version": "v1",
  "status": "failed",
  "error": {
    "code": "INVALID_INPUT",
    "message": "Process input is invalid"
  }
}
```

| HTTP 状态 | error.code | 含义 |
| ---: | --- | --- |
| 400 | `INVALID_INPUT` | 请求结构或业务输入无效 |
| 404 | `PROCESS_NOT_FOUND` | Process 或版本不存在 |
| 500 | `INVALID_OUTPUT`、`INTERNAL_ERROR` | 服务端输出无效或发生内部错误 |
| 502 | `AGENT_FAILURE`、`DEPENDENCY_FAILURE` | Prompt Agent、图片服务或存储服务不可用 |
| 504 | `PROCESS_TIMEOUT` | 处理超时 |

## 调用示例

PowerShell：

```powershell
$body = @{
    process = "news-image-pale-watercolor"
    version = "v1"
    input = @{
        title = "某城市开始使用无人机巡检老旧桥梁"
        summary = "首批巡检发现12处需要进一步检查的安全隐患。"
    }
} | ConvertTo-Json -Depth 4

Invoke-RestMethod `
    -Uri "https://pi.ganjiuwanshi.com/execute" `
    -Method Post `
    -ContentType "application/json" `
    -Body $body
```

curl：

```bash
curl -X POST 'https://pi.ganjiuwanshi.com/execute' \
  -H 'content-type: application/json' \
  -d '{
    "process": "news-image-pale-watercolor",
    "version": "v1",
    "input": {
      "title": "某城市开始使用无人机巡检老旧桥梁",
      "summary": "首批巡检发现12处需要进一步检查的安全隐患。"
    }
  }'
```

切换风格时只替换 `process`。不要增加 `style`、`skill` 或 `prompt` 字段。

## 服务边界

`POST /news-images` 是主 API 调用的内部 Business Capability，不提供给产品或浏览器直接调用。服务端负责选择 Runtime Skill、FAL GPT Image 2、输出尺寸和 OSS 前缀。生产部署还应在网关配置身份认证、请求限流、调用超时和费用告警。
