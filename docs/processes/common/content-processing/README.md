# `content-processing/v1` Business Process

本文面向维护文本处理能力的产品、开发和测试人员。`content-processing/v1` 接收一段非空文本，统一空白后调用 Content Processing Capability；服务端可以选择 Direct 或受限 Agent 路径，产品契约不随实现方式变化。

## 产品契约

调用方通过统一的 `POST /execute` 提交准确 Process 和版本：

```json
{
  "process": "content-processing",
  "version": "v1",
  "input": {
    "content": "  launch   offer  "
  }
}
```

`input` 是严格对象，只接受非空 `content`。Process 去掉首尾空白，并把连续空白折叠成一个空格。成功时，`output` 只包含 Capability 返回的非空文本：

```json
{
  "content": "Processed: launch offer"
}
```

调用方不能提交模式、Prompt、模型、Skill、Tool、Capability 地址、重试或超时配置。

## 执行顺序

服务端在 Composition Root 中选择一种模式：

- `direct`：Registration 把规范化文本交给 Content Processing Capability，并以 Process `runId` 作为下游幂等键。
- `agent`：Agent 固定加载 `content-optimization` 和 `content-integrity`，只获得 `process_business_content` Tool。Agent 必须恰好调用一次 Tool；最终文本必须与 Tool 结果完全一致。缺少 Tool、重复调用、非法结构或结果不一致都失败。

Agent 不能选择或替换 Skill，也不能使用 Shell、文件系统、代码编辑或任意远程工具。Capability 的 HTTP Adapter 与 Agent provider 都是服务端 Implementation。

运行活动日志使用固定名称：两种模式都记录 `content_processing`；Agent 模式还以 `content_optimization` 包住 Agent 调用和结果一致性校验。日志只记录活动结果与耗时，不记录文本、Tool 参数或模型消息。

## 错误与副作用

| 阶段 | 公开错误 | 条件 |
| --- | --- | --- |
| 输入接受 | `INVALID_INPUT` | 文本为空、字段类型错误或包含额外字段 |
| Agent 路径 | `AGENT_FAILURE` | Agent、Tool 调用次数或结果一致性不符合约束 |
| 业务依赖 | `DEPENDENCY_FAILURE` | Content Processing Capability 不可用或响应不符合协议 |
| 输出验证 | `INVALID_OUTPUT` | Process Definition 返回不符合输出 Schema 的结果 |
| 执行治理 | `PROCESS_TIMEOUT` | 总超时先于结果完成 |

Process 本身不持久化内容。远程 Capability 是否产生其他副作用由其业务契约负责；只有确认下游按 `runId` 去重后，服务端才可启用 Registration 的受控重试策略。

## 代码与验证入口

| 目标 | 文件 |
| --- | --- |
| 产品 Schema、模式和执行 invariant | [`src/processes/content/registration.ts`](../../../../src/processes/content/registration.ts) |
| Agent 与 Pi Adapter | [`src/processes/content/agent.ts`](../../../../src/processes/content/agent.ts)、[`src/processes/content/pi.ts`](../../../../src/processes/content/pi.ts) |
| Capability 与 HTTP Adapter | [`src/processes/content/capability.ts`](../../../../src/processes/content/capability.ts)、[`src/processes/content/http.ts`](../../../../src/processes/content/http.ts) |
| 固定 Skill 集合 | [`src/processes/content/skills.ts`](../../../../src/processes/content/skills.ts)、[`content-optimization`](../../../../.pi/skills/content-optimization/)、[`content-integrity`](../../../../.pi/skills/content-integrity/) |
| Process 与 Agent 确定性测试 | [`test/execute-process.test.ts`](../../../../test/execute-process.test.ts)、[`test/agent-runtime.test.ts`](../../../../test/agent-runtime.test.ts)、[`test/runtime-skills.test.ts`](../../../../test/runtime-skills.test.ts) |
| 显式真实 Agent smoke | [`examples/agent-smoke.ts`](../../../../examples/agent-smoke.ts) |

不联网的聚焦验证从仓库根目录运行：

```bash
npm test -- test/execute-process.test.ts test/agent-runtime.test.ts test/runtime-skills.test.ts
```

真实 Agent smoke 会联网并可能产生模型费用。凭证、判据和产物规则见 [`experiments.md`](../../../experiments.md)。
