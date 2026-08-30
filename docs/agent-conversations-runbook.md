# Agent Conversations 发布与运维手册

本文面向发布、SRE 和值班人员，用于启用、验证、观测和回滚 production `design-assistant/v1`。公开请求契约以 [`api.md`](api.md#agent-conversations多轮文本与图片资源) 为准；本页不定义第二套产品 API。

## 运行结论

`AGENT_CONVERSATIONS_ENABLED=false` 是默认值。关闭时四个 Agent Conversation 路由不挂载，现有同步与异步 Process API 行为不变。开启时必须同时运行 API、Process Dispatcher、Process Worker 和 Retention Cleaner；标准单服务器基础 Compose 没有这些后台角色，必须使用已通过门禁的异步生产形状。

PostgreSQL 是 Conversation、Turn、幂等、Outbox、Attempt、Tool Ledger、revision 和删除墓碑的事实来源。Redis/BullMQ 只负责唤醒。owned resource service 负责 caller 图片归属、模型内容与临时读取 URL。API 和 Worker 的 readiness 会校验 PostgreSQL、Redis、资源服务、固定 Runtime Skill、Pi 模型及所有活动 Conversation 所需的 Registration revision。

production Agent catalog 只有准确的 `design-assistant/v1`。它没有默认版本、回退或请求时注册；调用方也不能提交 Prompt、Context 策略、Memory、Skill、Tool、Process、模型、provider、预算、保留或运行参数。

## 发布前检查

候选提交先执行确定性验证：

```bash
npm run check
npm run typecheck
npm test
npm run build
```

真实 PostgreSQL 与 Redis 测试会重建明确的本地测试数据库并清空非零 Redis database，只能使用隔离地址：

```bash
docker compose -f compose.integration.yaml up -d --wait
export POSTGRES_TEST_DATABASE_URL=postgres://pipipi:pipipi-test-only@127.0.0.1:55432/pipipi_test
export REDIS_TEST_URL=redis://127.0.0.1:56379/15
npm run test:integration:agent-postgres
npm run test:integration:agent-tools:local
npm run test:integration:agent-runtime:local
docker compose -f compose.integration.yaml down
```

上述测试不调用真实模型或付费图片。真实设计建议、图片生成和资源写入 smoke 需要网络、凭证与费用，必须在候选已部署到受控 internal 环境后单独执行，不能混入确定性门禁，也不能自动重试 `DEPENDENCY_FAILURE_AFTER_COMMIT`。

数据库必须已应用 `010_agent_conversations.mjs` 到 `013_agent_conversation_retention.mjs`。按异步发布手册运行两次 migration verify；第二次必须没有待执行 migration。不要对生产执行 migration down。

## 配置所有权

以下变量必须由 Secret/部署配置管理，不得进入产品请求、镜像或日志。完整默认值与可选调优项见 [`.env.example`](../.env.example)。

| 角色 | 必需配置 |
| --- | --- |
| API | `AGENT_CONVERSATIONS_ENABLED=true`、`DATABASE_URL`、`REDIS_URL`、`PI_PROVIDER`、`PI_MODEL`、`AGENT_GATEWAY_SHARED_SECRET`、资源服务地址与 Secret、三个 backlog 控制 |
| Process Dispatcher | 同一开关、数据库、Redis、同一 Queue identity、三个 backlog 控制 |
| Process Worker | 同一开关、数据库、Redis、同一 Queue identity、Pi 模型与凭证、资源服务、三个 backlog 控制 |
| Retention Cleaner | 同一开关和数据库；清理批次参数可选 |

三个必需 admission 变量是 `AGENT_GLOBAL_BACKLOG_LIMIT`、`AGENT_CALLER_BACKLOG_LIMIT` 和 `AGENT_BACKLOG_RETRY_AFTER_SECONDS`。caller 上限不得大于全局上限。请求不能覆盖这些值；caller 与全局饱和都返回 HTTP 429 和固定 `Retry-After`。

`AGENT_GATEWAY_SHARED_SECRET` 与 `AGENT_RESOURCE_SERVICE_SHARED_SECRET` 至少 32 bytes、用途分离。入口网关必须删除外部 `x-pipipi-caller-id` 和 `x-pipipi-gateway-token`，完成用户认证后再注入内部 caller identity。应用端口和资源服务端口只能由受信网络访问。

owned resource service 必须实现 `GET /readyz`，以及 Bearer Secret 保护的 `POST /agent-resources/inspect`、`POST /agent-resources/model-content`、`POST /agent-resources/read-projection` 和 `POST /agent-resources/process-output`。最后一个接口只接收 Worker 已成功执行的 priced Process Tool envelope，把其中业务图片复制或登记为当前 owner/Turn 的稳定资源，并返回保持原 invocation/process/version/status、但图片包含 `resourceId` 的净化 envelope。后续 `inspect` 必须能用同一 owner、Turn 和 `resourceId` 证明输出来源；失败按 after-commit 处理，不能重新执行付费 Tool。资源服务不得记录 Bearer Secret、业务图片 URL、模型内容或完整 Tool envelope。

Runtime Skill 固定为 `.pi/skills/design-assistant/SKILL.md` 的准确 name/version/SHA-256。`PI_DESIGN_ASSISTANT_SKILL_DIRECTORY` 只允许部署时切换到内容完全相同的受审快照，不能绕过摘要校验。模型、provider 和 endpoint 是行为配置的一部分；任何变化都会生成新的 `configRevision`。

## 分阶段启用

1. 保持所有角色 `AGENT_CONVERSATIONS_ENABLED=false`，发布代码与 additive migration，确认原有 `/execute`、异步 Process Run 和角色 readiness 不变。
2. 在四份角色配置中写入相同开关、数据库、Redis、Queue identity 和 admission 值；API/Worker 使用相同 Pi 与资源服务配置。逐角色运行 `npm run check:deployment-env -- <role>`。
3. 先在 internal 环境启动 Retention Cleaner、Dispatcher 和 Worker，确认各自 `/readyz` 为 200；最后启用 API。若任一依赖、Skill、模型或 Registration revision 不可用，readiness 必须保持 503。
4. 通过真实认证网关分别用两个 caller 创建文本 Conversation，验证 owner 隔离、幂等重放、轮询终态、追加 Turn 和删除。图片 smoke 先由 owned resource service 创建 caller-owned `resourceId`；四个业务路由不接受上传、URL 或 base64。
5. 人工验证 caller/global backlog 429、`Retry-After`、Worker 重启、Redis Job 重建、删除立即不可见和 Cleaner 最迟 24 小时物理清理，再逐步放量。

不要在一次发布中同时更换 Queue identity、模型、Skill、网关 Secret 和 admission 上限。每次只改变一个可观测维度，并保留上一个可回滚镜像和角色配置。

## Registration revision 升级

`configRevision` 是固定指令、Runtime Skill 摘要、Context/Memory 策略、Process Tool allow-list、模型策略、预算、输出和保留策略的确定性摘要。新 Conversation 使用当前 revision；已有 Conversation 必须继续用创建时的 revision。

改变任一行为配置时，先把旧 Registration 作为 retained Registration 随新版本发布。API/Worker readiness 会扫描 `busy` 和 `ready` Conversation；发现数据库引用未随发布保留的 revision 会 fail closed。只有依赖旧 revision 的 Conversation 全部删除或过期并被清理后，才能在后续发布移除该 retained Registration。禁止通过数据库改写 `config_revision` 迁移活动 Conversation。

## 观测与告警

Agent 活动日志只允许稳定 identity、Agent id/version、`configRevision`、Attempt、状态、净化错误码、计数、deadline、cursor 与耗时。不得记录用户文本、图片 URL/base64、Prompt、隐藏推理、Tool 输入输出正文、provider 原始响应、模型 endpoint、Secret 或连接 URL。

至少告警以下信号：

- 任一角色 readiness 持续 503；
- caller/global admission 429 比例异常；
- queued Turn 年龄超过 reconciliation 阈值，或 running lease 反复过期；
- `DEPENDENCY_FAILURE_AFTER_COMMIT`、`RESOURCE_UNAVAILABLE` 或 `INVALID_OUTPUT` 突增；
- Cleaner 无进展、`deleteBy` 已过但墓碑仍存在；
- active Conversation 引用不可用 Registration revision。

## 回滚与停用

紧急止血先在入口网关停止新 Agent 流量，再把 API 的 `AGENT_CONVERSATIONS_ENABLED` 改为 `false`；这会卸载公开路由，但不会删除 PostgreSQL 状态。只要仍有 queued/running Turn，Dispatcher 和 Worker 应继续运行到清空或由运维明确 fencing；Cleaner 应继续处理已接受删除和过期记录。

镜像回滚必须保留当前数据库中所有活动 Conversation 需要的 Registration revision。旧镜像若不认识新 revision，readiness 会失败，此时不能强制接流量；应部署同时包含新旧 revision 的兼容镜像，或等待相关 Conversation 删除/过期。回滚不删除 Redis Queue、不清空 PostgreSQL、不执行 migration down，也不重新执行可能收费的 Tool。

## 明确不在当前能力内

Canvas 页面只是未来对 Agent Content Block 和业务 artifact 的展示层，不改变当前 API。跨 Conversation 长期 Memory、图片上传、SSE/流式事件、调用方自定义 Agent、远程 Skill 安装和调用方可选模型也都不在本版本；新增这些能力必须先定义独立契约、权限、保留和费用门禁。
