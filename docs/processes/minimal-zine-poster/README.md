# `minimal-zine-poster/v1` Business Process

本文面向维护极简 zine 海报能力的产品、开发和测试人员。`minimal-zine-poster/v1` 把 brief 和可选画面文字编译成受审查的海报 Prompt，再通过 Poster Rendering Capability 生成并持久化 3:5 图片。

## 产品契约

```json
{
  "process": "minimal-zine-poster",
  "version": "v1",
  "input": {
    "brief": "为雨天旧书店做一张安静的海报",
    "text": "PIPIPI ZINE"
  }
}
```

`input` 是严格对象。`brief` 必须是 1–12000 个字符；可选 `text` 必须是 1–80 个字符。当前版本不接受参考图片、画幅、Prompt、模型、Skill、存储或重绘参数。

成功输出包含四部分：

| 字段 | 含义 |
| --- | --- |
| `prompt` | 通过 Registration 校验的四段内部生成说明 |
| `recipe` | 固定六轴 `layout`、`anchor`、`typography`、`accent`、`texture`、`mood` |
| `interpretation` | Agent 对 brief 的简短解释 |
| `image` | HTTP(S) URL、媒体类型、宽高和可选过期时间 |

若请求包含 `text`，Prompt 必须逐字保留该文字。输出图片必须接近 3:5；原始图片字节不进入 `/execute` JSON。

## 执行顺序

1. Registration 规范化 brief，并保留可选 `text`。
2. 无 Tool Agent 只加载固定的 `minimal-zine-poster-prompt` Runtime Skill，编译四段 Prompt、六轴 recipe 和 interpretation。
3. Registration 验证结构、枚举值、核心视觉约束和可选原文；失败时不调用图片服务。
4. Registration 以 Process `runId` 作为幂等键，只调用一次 Poster Rendering Capability，画幅固定为 `3:5`。
5. Registration 验证图片 URL、媒体类型、尺寸和比例，再返回公开输出。

Agent 没有 Tool，也不能使用 Shell、文件系统、代码编辑或任意网络能力。图片模型、供应商、对象存储和 URL 策略由受控 `POST /posters` Business API 拥有。

## 错误与副作用

| 阶段 | 公开错误 | 条件 |
| --- | --- | --- |
| 输入接受 | `INVALID_INPUT` | brief 或 text 不符合 Schema，或包含额外字段 |
| Prompt 编译 | `AGENT_FAILURE` | Agent 失败，或 Prompt、recipe、原文保留未通过校验 |
| 图片依赖 | `DEPENDENCY_FAILURE` | Rendering Capability 不可用或响应不符合协议 |
| 输出验证 | `INVALID_OUTPUT` | 图片 URL、媒体类型、尺寸或 3:5 比例不符合契约 |
| 执行治理 | `PROCESS_TIMEOUT` | 总超时先于结果完成 |

图片生成和持久化会产生费用与外部写入。Registration 默认不重试；下游必须用 `runId` 去重，并由部署方限制身份、并发、超时和费用。

## 代码与验证入口

| 目标 | 文件 |
| --- | --- |
| 产品 Schema、Prompt 校验和执行顺序 | [`src/processes/poster/registration.ts`](../../../src/processes/poster/registration.ts) |
| Agent 与 Pi Adapter | [`src/processes/poster/agent.ts`](../../../src/processes/poster/agent.ts)、[`src/processes/poster/pi.ts`](../../../src/processes/poster/pi.ts) |
| Capability 与 HTTP Adapter | [`src/processes/poster/capability.ts`](../../../src/processes/poster/capability.ts)、[`src/processes/poster/http.ts`](../../../src/processes/poster/http.ts) |
| Skill 绑定、规则与来源 | [`src/processes/poster/skills.ts`](../../../src/processes/poster/skills.ts)、[`minimal-zine-poster-prompt`](../../../.pi/skills/minimal-zine-poster-prompt/) |
| 确定性 Process 与 Adapter 测试 | [`test/poster-process.test.ts`](../../../test/poster-process.test.ts)、[`test/poster-http.test.ts`](../../../test/poster-http.test.ts)、[`test/runtime-skills.test.ts`](../../../test/runtime-skills.test.ts) |
| 显式真实业务验收 | [`examples/poster-business-acceptance.ts`](../../../examples/poster-business-acceptance.ts) |

不联网、不产生模型费用的聚焦验证：

```bash
npm test -- test/poster-process.test.ts test/poster-http.test.ts test/runtime-skills.test.ts
```

真实业务验收会联网、调用图片模型，并可能写入对象存储：

```bash
npm run accept:poster-business
```

运行前必须确认凭证、费用和测试内容。环境变量、判据和 `artifacts/` 报告位置见 [`experiments.md`](../../experiments.md)。当前版本不做自动看图质检、自动重绘或参考图转换。
