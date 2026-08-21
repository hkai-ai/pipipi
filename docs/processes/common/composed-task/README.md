# `composed-task/v1` Business Process

本文面向维护组合任务能力的产品、开发和测试人员。`composed-task/v1` 让一个服务端 Planner Agent 在固定预算内组合 allow-list 中的其他 Business Process 来完成一个自然语言目标。动态的是步骤组合；每一步仍是一次受完整治理的 Member Process 执行。该 Process 随应用发布但默认关闭。

## 产品契约

```json
{
  "process": "composed-task",
  "version": "v1",
  "input": {
    "goal": "把这段介绍精简后做一张极简 zine 海报",
    "material": { "copy": "雨天的旧书店，安静、缓慢。" },
    "constraints": { "maxSteps": 3 }
  }
}
```

`goal` 是 1–4000 个字符的目标；`material` 至多 16 个字符串条目，是 Planner 能转交给各步骤的全部素材；`constraints.maxSteps` 只能收紧服务端上限。请求不能包含步骤、Process 顺序、Skill、模型或 Tool。

成功输出 `summary`、按顺序的 `steps`（含失败步骤）和 `result`。`result` 必须逐字取自成功步骤的输出：完整 `output`、其中一个子值，或由这类子值组成的平铺对象。字段约束与失败码见 [`api.md`](../../../api.md#processcomposed-taskv1)。

## 执行顺序

1. Registration 计算本次预算：`maxSteps = min(constraints.maxSteps, COMPOSED_TASK_MAX_STEPS)`，`maxPricedSteps = COMPOSED_TASK_MAX_PRICED_STEPS`。
2. Process Tool Set 为每个 allow-list Member 绑定一个 Step Tool；Tool 参数 Schema 由 Member 自己的 `inputSchema` 推导。
3. 活动 `planner_session` 内启动一次请求级 Pi Session。系统提示只含固定指令、`composed-task-planner` Runtime Skill 和 Tool 描述；Pi 内置 Tool、扩展、文件和网络均不可用。
4. Planner 每调用一个 Tool，Tool Set 在父活动 `process_step` 内以派生 `runId`（`<父runId>.<步骤号>`）经 Process Attempt Runner 执行一个 Step Run。Member 的 `accept`、超时、取消、幂等键和活动日志原样生效；父超时或取消会终止进行中的 Step。Member `accept` 拒绝时 Tool 把 `INVALID_INPUT` 回传给 Planner，让它修正后重试。
5. 步数或付费步数耗尽后，Tool 返回 `STEP_BUDGET_EXHAUSTED` / `PRICED_BUDGET_EXHAUSTED` 而不运行 Member；Session 另有 `maxSteps + 2` 次调用的硬上限，超过即中止。
6. Planner 以 `{ summary, result }` 收尾。Registration 用自己的 Step 记账生成 `steps`，校验 `result` 来源，再返回公开输出。

allow-list 位于 [`members.ts`](../../../../src/processes/composed/members.ts)：当前为其余七个 production Process，其中海报、CRT 与三个新闻图片 Process 标记为付费。新增能力走常规的新增 Business Process 流程，再在该文件加一行。

## 错误与副作用

| 阶段 | 公开错误 | 条件 |
| --- | --- | --- |
| 输入接受 | `INVALID_INPUT` | `goal`、`material` 或 `constraints` 不符合 Schema，或包含额外字段 |
| 规划 | `AGENT_FAILURE` | 没有任何成功步骤、Planner 输出无法解析，或 `result` 不是逐字取自成功步骤 |
| 依赖 | `DEPENDENCY_FAILURE` | 运行过的步骤全部因业务服务不可用失败，且无付费步骤成功 |
| 已提交后失败 | `DEPENDENCY_FAILURE_AFTER_COMMIT` | 至少一个付费步骤成功后 Planner 失败、超时或输出无效 |
| 执行治理 | `PROCESS_TIMEOUT` | 超过 `COMPOSED_TASK_TIMEOUT_MS`（默认 600000 毫秒） |

一次调用可能触发多次付费图片生成。该 Process 不重试；Member 自己的重试策略在 Step 中不生效，需要重试由 Planner 在预算内显式再调一次。开放给外部调用前必须有按 caller 的配额。

## 配置

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `COMPOSED_TASK_ENABLED` | `false` | 为 `true` 时注册该 Process 并校验 Planner Skill |
| `COMPOSED_TASK_MAX_STEPS` | `6` | 服务端步数上限，1–8 |
| `COMPOSED_TASK_MAX_PRICED_STEPS` | `2` | 单次 Run 允许成功的付费步骤数，0–4 |
| `COMPOSED_TASK_TIMEOUT_MS` | `600000` | 该 Process 自己的超时；异步 Worker 的 `PROCESS_RUN_CLAIM_LEASE_MS` 必须大于它 |
| `PI_COMPOSED_SKILL_DIRECTORY` | `.pi/skills/composed-task-planner` | Planner Runtime Skill 路径覆盖 |

## 代码与验证入口

| 目标 | 文件 |
| --- | --- |
| 产品 Schema、预算、失败映射和 `result` 校验 | [`src/processes/composed/registration.ts`](../../../../src/processes/composed/registration.ts) |
| Member allow-list、Step Tool 与 Step Run | [`members.ts`](../../../../src/processes/composed/members.ts)、[`tools.ts`](../../../../src/processes/composed/tools.ts)、[`steps.ts`](../../../../src/processes/composed/steps.ts) |
| Planner Agent Port 与 Pi 实现 | [`agent.ts`](../../../../src/processes/composed/agent.ts)、[`agent.pi.ts`](../../../../src/processes/composed/agent.pi.ts)、[`src/agent-runtime/tooled.ts`](../../../../src/agent-runtime/tooled.ts) |
| 生产装配与 Skill 绑定 | [`production.ts`](../../../../src/processes/composed/production.ts)、[`skills.ts`](../../../../src/processes/composed/skills.ts)、[`composed-task-planner`](../../../../.pi/skills/composed-task-planner/) |
| 确定性测试 | [`test/composed-process.test.ts`](../../../../test/composed-process.test.ts)、[`test/production-catalog.test.ts`](../../../../test/production-catalog.test.ts)、[`test/agent-runtime.test.ts`](../../../../test/agent-runtime.test.ts)、[`test/startup-construction.test.ts`](../../../../test/startup-construction.test.ts) |

不联网、不产生模型费用的聚焦验证：

```bash
npm test -- test/composed-process.test.ts test/production-catalog.test.ts test/agent-runtime.test.ts test/startup-construction.test.ts
```

真实模型路径尚无脚本化验证。要人工验证，在受控环境设置 `COMPOSED_TASK_ENABLED=true`、Pi 模型凭证与 Business API 后，向 `POST /execute` 提交上面的请求；这会调用模型并可能触发付费图片生成与对象存储写入。
