# Business Processing Service

一个轻量的业务处理服务原型。产品调用方只需要指定 Business Process、明确版本和业务输入；流程内部按代码定义依次完成预处理、处理和后处理。每个阶段可以使用本地逻辑、直接 API 或受限 Agent，调用方不需要指定实现方式。

当前包含两个代码定义流程：

- `content-processing` / `v1`：输入和输出均为 `{ "content": string }`，服务端可配置为直接调用能力或通过 Pi Agent 优化。
- `titled-content-processing` / `v1`：输入为 `{ "title": string, "body": string }`，输出为 `{ "title": string, "content": string }`，复用同一个内容处理能力，但拥有独立的整理阶段和配置。

流程由 Process Registry 注册，通过 Process Runner 执行。远程业务调用实现为可替换的 Business Capability Adapter，因此多个流程可以复用同一能力，测试也可以注入受控 Adapter。

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

默认使用不启动 Agent 的确定性直接路径。单次流程超时为 30 秒，单次业务 API 调用超时为 10 秒，可以分别通过 `PROCESS_TIMEOUT_MS` 和 `BUSINESS_API_TIMEOUT_MS` 调整。

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

第二个流程仍使用同一个 `/execute` 接口：

```bash
curl -X POST http://127.0.0.1:3000/execute \
  -H 'content-type: application/json' \
  -d '{
    "process": "titled-content-processing",
    "version": "v1",
    "input": { "title": "Launch", "body": "New offer" }
  }'
```

## 可选 Pi Agent 路径

Agent 只由服务端为 `content-processing` 流程开启，产品请求和输出契约不会变化：

```bash
BUSINESS_API_BASE_URL=http://127.0.0.1:4000 \
CONTENT_PROCESSING_MODE=agent \
npm run dev
```

Pi Agent 每次请求创建独立的内存会话，显式加载 `.pi/skills/content-optimization/SKILL.md`，并且只允许调用 `process_business_content` 这一个参数受校验的 Tool。该 Tool 包装已有的 Business Capability；Shell、文件读写、代码编辑等 Coding Tools 不会暴露给 Agent。

默认使用 Pi 已配置的模型和认证。需要固定模型时同时设置 `PI_PROVIDER` 和 `PI_MODEL`；也可以通过 `PI_AGENT_DIR` 指定 Pi 配置目录。只设置其中一个模型字段会在启动时被拒绝。

真实模型冒烟验证不会进入默认测试套件。先运行演示业务 API，再执行：

```bash
BUSINESS_API_BASE_URL=http://127.0.0.1:4000 npm run smoke:agent
```

该命令会临时启动 Agent 模式服务、完成一次真实 `/execute` 请求后退出，因此需要可用的 Pi 模型凭证，并可能产生模型费用。

## 增加业务流程

流程结构保持在 TypeScript 代码中，不使用 JSON 工作流语言：

1. 新建一个工厂函数，通过 `defineProcess` 声明固定的 `id`、`version`、输入 Schema、输出 Schema 和 `execute` 阶段。
2. 在 `createProcessingApplication` 的 Process Registry 中注册这个工厂函数。
3. 通过 `context.capabilities` 复用已有能力，或增加一个窄接口 Adapter；不要让产品请求携带步骤、URL 或实现选择。
4. 为新流程增加独立的服务端配置和 `/execute` 外部行为测试。

`src/titled-content-processing.ts` 是最小可复制示例。只有稳定的运行开关、超时和分隔符等策略使用环境配置；流程拓扑和业务语义仍由代码与测试约束。

## 接口约束

- 流程由服务端代码定义，调用方不能上传流程步骤、脚本或远程地址。
- 未注册的流程或版本返回 `PROCESS_NOT_FOUND`。
- 无效业务输入返回 `INVALID_INPUT`。
- 远程 Business Capability 不可用时返回 `DEPENDENCY_FAILURE`，不会透传远端错误内容。
- 超过流程总时限时返回 `PROCESS_TIMEOUT`。
- Agent 执行或结构化输出失败时返回 `AGENT_FAILURE`，不会透传模型或认证错误。
- 当前版本是同步最小实现，不包含鉴权、幂等、队列、持久化执行记录或通用编排器。

## 验证

```bash
npm run typecheck
npm test
npm run build
```
