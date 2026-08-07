# Business Processing Service

一个轻量的业务处理服务原型。产品调用方只需要指定 Business Process 和版本；流程内部可以执行本地处理并直接调用远程 Business Capability，不需要经过 Agent。

当前只有一个代码定义流程：`content-processing` / `v1`。

流程由 Process Registry 注册，通过 Process Runner 执行。远程业务调用实现为可替换的 Business Capability Adapter，因此后续流程可以复用同一能力，测试也可以注入受控 Adapter。

## 本地运行

要求 Node.js 24 或更高版本。

安装依赖：

```bash
npm install
```

终端一启动演示业务 API：

```bash
npm run dev:business-api
```

终端二启动处理服务：

```bash
BUSINESS_API_BASE_URL=http://127.0.0.1:4000 npm run dev
```

默认单次流程超时为 30 秒，单次业务 API 调用超时为 10 秒。可以分别通过 `PROCESS_TIMEOUT_MS` 和 `BUSINESS_API_TIMEOUT_MS` 调整。

调用流程：

```bash
curl -X POST http://127.0.0.1:3000/execute \
  -H 'content-type: application/json' \
  -d '{
    "process": "content-processing",
    "version": "v1",
    "input": { "content": "  launch   offer  " }
  }'
```

成功响应包含 `runId` 和经过业务 API 处理、后处理后的结构化 `output`：

```json
{
  "runId": "...",
  "process": "content-processing",
  "version": "v1",
  "status": "succeeded",
  "output": { "content": "Processed: launch offer" }
}
```

## 接口约束

- 流程由服务端代码定义，调用方不能上传流程步骤、脚本或远程地址。
- 未注册的流程或版本返回 `PROCESS_NOT_FOUND`。
- 无效业务输入返回 `INVALID_INPUT`。
- 远程 Business Capability 不可用时返回 `DEPENDENCY_FAILURE`，不会透传远端错误内容。
- 超过流程总时限时返回 `PROCESS_TIMEOUT`。
- 当前版本是同步最小实现，不包含 Agent、鉴权、幂等、队列或持久化执行记录。

## 验证

```bash
npm run typecheck
npm test
npm run build
```
