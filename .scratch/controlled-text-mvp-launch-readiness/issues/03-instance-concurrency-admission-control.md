# 03 — 限制实例内并发

**What to build:** 为进入 Process Runner 的执行增加实例内并发闸门，使少量受控调用方可以并行使用服务，同时把内存、下游请求和模型调用数量限制在明确范围内。容量已满时立即给出可重试响应，不在进程内积压无界队列。

**Blocked by:** 01 — 补齐安全 HTTP 边界与健康检查.

**Status:** resolved

- [x] 同一实例同时进入 Process Runner 的请求数不超过配置的上限，且上限以内的请求仍可真实并行执行。
- [x] `MAX_CONCURRENT_EXECUTIONS` 未设置时默认为 4；空值、零、负数、小数和非数字值会以安全且清晰的配置错误阻止服务启动。
- [x] 容量已满时，新执行立即返回 HTTP 503、稳定错误码 `SERVICE_BUSY` 和短暂的 `Retry-After` 指引，不进入 Process Runner，也不建立无界内存队列。
- [x] 健康检查、媒体类型拒绝和请求体大小拒绝不获取执行槽。
- [x] 执行槽在成功、结构化 Process Failure、意外失败和总超时后都通过可靠的清理路径释放；一次失败不会永久降低实例容量。
- [x] 配置为两个槽时，最高层并发测试能够挂起两个执行、拒绝第三个执行，并在任一执行结束后接受新的请求。
- [x] 并发隔离测试使用不同哨兵内容，证明每个响应和外部能力调用只包含本次请求的数据，且请求级 Agent 会话不会交叉。

## Answer

Implemented fail-fast per-instance admission control with a default of four active executions. Saturated instances return `503 / SERVICE_BUSY` and `Retry-After: 1` without queuing or entering the Process Runner. Tests prove true two-request parallelism, third-request rejection, slot release across every terminal path, rejection/health bypass, and sentinel isolation for parallel Agent-backed requests.
