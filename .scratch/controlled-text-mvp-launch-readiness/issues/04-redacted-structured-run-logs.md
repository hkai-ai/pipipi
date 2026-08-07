# 04 — 增加脱敏结构化运行日志

**What to build:** 为每次真正进入 Process Runner 的执行输出一条可检索、字段受控的完成记录，并为传输拒绝和容量拒绝输出最小诊断事件。运维可以按运行标识、流程和安全错误码定位 MVP 故障，同时业务内容、Agent 上下文和秘密信息不会进入日志。

**Blocked by:** 02 — 限制 JSON 类型与请求体大小；03 — 限制实例内并发.

**Status:** resolved

- [x] 服务提供可注入的日志出口供测试使用，生产默认把每条记录作为单行 JSON 输出到 stdout。
- [x] 每个进入 Process Runner 并结束的执行恰好产生一条 `process_run_completed` 记录。
- [x] 完成记录只包含明确允许的字段：事件名、时间戳、运行标识、Business Process 标识、版本、最终状态、毫秒耗时，以及存在时的安全错误码。
- [x] 媒体类型、请求体大小和容量拒绝分别产生最小结构化事件，只包含事件名、时间戳、HTTP 状态、安全错误码和有意义时的耗时。
- [x] 意外 HTTP 处理失败产生脱敏结构化事件，并继续向调用方返回第一张票定义的安全 500 响应。
- [x] 日志通过显式字段白名单构造，不序列化请求、结果、捕获异常或环境对象；业务输入输出、Prompt、模型消息、Tool 参数、授权值、API 密钥、堆栈和原始异常均不得出现。
- [x] 耗时使用适合测量时间间隔的时钟；测试可以控制日志出口和时间，而产品调用契约不暴露这些实现细节。
- [x] 最高层 HTTP 测试同时验证成功、结构化失败、超时、三种准入拒绝和意外失败的日志数量、关联字段与敏感信息缺失。

## Answer

Implemented injectable, allowlisted run logging with a monotonic duration clock and one-line JSON stdout output. Each completed Process Run emits exactly one `process_run_completed` record; transport, capacity, and unexpected failures emit minimal redacted records. HTTP tests verify event counts, stable correlation fields, controlled timing, and absence of bodies, prompts, authorization values, keys, stack traces, and raw exceptions.
