# 02 — 限制 JSON 类型与请求体大小

**What to build:** 在请求进入 Process Runner 前实施明确的传输准入控制。标准 JSON 请求继续工作，非 JSON 或超大请求获得稳定、可编程处理的错误，而且不会消耗 Business Capability、Agent 或模型资源。

**Blocked by:** 01 — 补齐安全 HTTP 边界与健康检查.

**Status:** resolved

- [x] `POST /execute` 接受 `application/json`，包括带 UTF-8 charset 等合法参数的媒体类型。
- [x] 其他媒体类型返回 HTTP 415 和稳定错误码 `UNSUPPORTED_MEDIA_TYPE`，且不进入 Process Runner。
- [x] 原始请求体按字节而不是 JavaScript 字符数计量；未配置时采用 262144 字节的保守上限。
- [x] 已声明超过上限的请求和分块传输中越过上限的请求都返回 HTTP 413 和稳定错误码 `REQUEST_TOO_LARGE`。
- [x] 415 和 413 响应不回显请求内容，不为尚未进入 Process Runner 的请求虚构运行标识，也不会调用 Business Capability 或 Agent Runtime。
- [x] 请求体上限可通过 `HTTP_MAX_REQUEST_BODY_BYTES` 配置；未设置时使用默认值，空值、零、负数、小数和非数字值会以安全且清晰的配置错误阻止服务启动。
- [x] 最高层 HTTP 测试覆盖合法 JSON、带 charset 的 JSON、非法媒体类型、声明超限、流式超限以及上限内请求的原有执行行为。

## Answer

Implemented pre-execution media-type and raw-byte admission checks. JSON with parameters is accepted; unsupported media types return `415 / UNSUPPORTED_MEDIA_TYPE`; declared and streamed oversized bodies return `413 / REQUEST_TOO_LARGE`. Focused startup tests cover the 262144-byte default and reject every invalid `HTTP_MAX_REQUEST_BODY_BYTES` form without exposing request data or invoking execution dependencies.
