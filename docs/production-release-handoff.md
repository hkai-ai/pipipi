# 生产发布后端交接

本文供后端、SRE 和发布审核人判断当前候选能否进入生产 `internal` 阶段。状态快照日期为 2026-08-31；规范步骤仍以[同步发布手册](mvp-release-runbook.md)、[异步发布手册](async-process-runs-runbook.md)和 [Agent Conversations 发布手册](agent-conversations-runbook.md)为准。

## 结论

当前代码已在本地提交，尚未进入两个 Git 远端的 `main`，也尚未部署。本文档通过评审分支共享，不会触发生产部署。Actions 显示生产最后一次受控发布使用显式异步形状；服务器核对若未发现流程外变更，标准 `Production CI/CD` 会拒绝把它隐式替换为同步形状。本次必须复用该流水线生成的不可变 artifact，再手动运行 `Async internal release`。

本次只发布代码和 additive migration，并保持以下边界：

- `ASYNC_RELEASE_STAGE=internal`，只接受受控内部流量；
- `AGENT_CONVERSATIONS_ENABLED=false`，不开放 Agent Conversation 路由；
- 不提升到 `canary` 或 `production` 流量；
- 不执行 migration down，不清理 PostgreSQL Run、Outbox、Delivery 或 Redis Queue；
- 不运行真实模型、付费图片或外部资源写入 smoke。

满足[后端确认项](#后端确认项)后，发布操作者还需列出最终 commit、两个推送目标、两个 workflow 及其输入，再取得一次明确发布授权。

## 当前状态

| 项目 | 2026-08-31 快照 | 说明 |
| --- | --- | --- |
| 本地实现 HEAD | `6a128afb61c5e47688c0f00a09ba5648182b2c30` | 本文档创建前的代码提交；最终候选以提交本文档后的完整 40 位 SHA 为准 |
| `origin/main` | `37bb254df571d4ccdeaff48650f47b8972de5f7a` | 协作主仓库 |
| `personal/main` | `37bb254df571d4ccdeaff48650f47b8972de5f7a` | 个人副本 |
| 评审分支 | `codex/production-release-handoff` | 仅供后端拉取代码和本文档，不是生产发布分支 |
| `main` 候选代码差异 | 12 个实现提交 | 主要包含 Agent Conversations、Process Tool 治理、四个 additive migration 和本地文本联调入口；不含本文档提交 |
| 最近成功的生产 CI 候选 | `d7681a6939509cb54b1a29785a0ef127eed19d9a` | [Production CI/CD 运行记录](https://github.com/hkai-ai/pipipi/actions/runs/31944891505) |
| 最近成功的异步 internal 发布 | `d7681a6939509cb54b1a29785a0ef127eed19d9a` | [Async internal release 运行记录](https://github.com/hkai-ai/pipipi/actions/runs/31945054938) |

Actions 证据显示，生产最后一次受控发布的 revision 应为 `d7681a6939509cb54b1a29785a0ef127eed19d9a`。服务器仍可能发生流程外变更，因此后端必须用下面的只读命令确认活动 revision，不能只依据 Actions 历史。

## 候选的部署影响

候选在 `origin/main` 之上增加 12 个提交，核心变化如下：

- 增加 `design-assistant/v1` 的多轮文本、owner 图片资源、受控 Process Tool、持久化恢复、删除和保留闭环；
- 增加 `010_agent_conversations` 至 `013_agent_conversation_retention` 四个 additive migration；
- 复用现有 API、Process Dispatcher、Process Worker 和 Retention Cleaner，不增加新的生产容器；
- 增加开发机使用的本地文本联调服务，不作为独立生产角色；
- 默认关闭 Agent Conversations，因此本次发布不改变现有产品调用入口。

本地已完成以下确定性门禁：

| 门禁 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm run typecheck` | 通过 |
| `npm test` | 106 个文件、937 个测试通过；10 个文件、90 个测试按条件跳过 |
| `npm run build` | 通过 |
| `npm run check:deployment:async-shape` | 通过 |
| Agent Conversation PostgreSQL 集成测试 | 15 个通过 |
| Process Tool Ledger PostgreSQL 集成测试 | 5 个通过 |
| Agent Turn BullMQ 集成测试 | 5 个通过 |

这些结果不包含生产服务器、真实模型、付费图片或外部资源服务验证。推送后，GitHub 上同一候选的 `Check and build` 与 `Async durable acceptance` 仍必须成功。

## 为什么不能直接运行普通部署

`.github/workflows/production-ci-cd.yml` 面向同步默认形状。它发现服务器已有显式异步容器时，会拒绝隐式删除 Dispatcher、Worker 和 Cleaner。这项失败防止错误降级，不应绕过。

正确路径是：

1. 让 `Production CI/CD` 对最终候选完成 `Check and build` 与 `Async durable acceptance`，并生成 `pipipi-<commit>` artifact。
2. 如果流水线仅在 `Deploy production` 的异步形状保护处失败，不把它误判为候选构建失败；先核对上述两个必需 Job 都成功。
3. 用该 CI run ID 手动运行 `.github/workflows/async-internal-release.yml`。
4. 发布成功后运行 `.github/workflows/async-internal-smoke.yml`，验证真实网关和安全关闭新 intake 的回滚边界。

`Async internal release` 会校验候选、artifact、数据库边界、migration、Recovery、六个容器的 revision 和 readiness。切换后的门禁失败会恢复先前镜像和 Compose 形状，但不会执行 migration down。

## 后端确认项

发布前请后端或 SRE 完成以下核对：

- 确认服务器上六个容器都在运行，并记录实际活动 revision；
- 提供已复核的 PostgreSQL `backup_id` 或 restore-point 标识，并确认该恢复点可用；
- 确认 `async-internal` Environment 或可继承的组织级配置中存在以下四项 smoke Secret：

  - `ASYNC_INTERNAL_CALLER_A_AUTHORIZATION`
  - `ASYNC_INTERNAL_CALLER_B_AUTHORIZATION`
  - `ASYNC_INTERNAL_SUCCESS_REQUEST`
  - `ASYNC_INTERNAL_FAILURE_REQUEST`

- 确认五份异步角色 Secret 文件、数据库 CA 和 Redis 依赖仍可用；发布 workflow 会再次做机器校验；
- 确认 `async-internal` Environment 的 required reviewer 能在发布窗口内审核；
- 确认本次只发布代码，继续保持 `internal` 阶段和 `AGENT_CONVERSATIONS_ENABLED=false`。

当前账号可见的仓库级和 `async-internal` Environment Secret 列表无法证明上述四项 smoke Secret 已配置；它们也可能由组织级 Secret 提供。请只回复“可用”或“不可用”，不要把 Secret 值、Authorization、请求正文、连接 URL 或数据库凭证写入 Issue、聊天或本文档。

## 服务器只读核对

在生产服务器上执行以下命令不会更改容器或数据库：

```bash
docker ps --filter 'name=^/pipipi' --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'

for name in \
  pipipi \
  pipipi-business-api \
  pipipi-process-dispatcher \
  pipipi-process-worker \
  pipipi-webhook-worker \
  pipipi-retention-cleaner
do
  docker inspect "$name" \
    --format '{{.Name}} image={{.Config.Image}} revision={{index .Config.Labels "com.pipipi.revision"}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
done

for port in 4300 4310 4320 4340 4350 4400
do
  curl --fail --silent --show-error "http://127.0.0.1:$port/healthz" >/dev/null
  curl --fail --silent --show-error "http://127.0.0.1:$port/readyz" >/dev/null
done

docker exec pipipi sh -c \
  'printf "ASYNC_RELEASE_STAGE=%s\n" "$ASYNC_RELEASE_STAGE"'

for name in \
  pipipi \
  pipipi-process-dispatcher \
  pipipi-process-worker \
  pipipi-retention-cleaner
do
  printf '%s ' "$name"
  docker exec "$name" sh -c \
    'printf "AGENT_CONVERSATIONS_ENABLED=%s\n" "${AGENT_CONVERSATIONS_ENABLED:-false}"'
done
```

成功信号是六个容器均为 running/healthy、revision 完全一致，十二个 health/readiness 请求全部成功，API 为 `internal`，并且四个相关角色都关闭 Agent Conversations。任一结果不一致时停止发布，先按[异步发布手册](async-process-runs-runbook.md#回滚边界)处理现有生产状态。

## 后端回复模板

请复制下面的模板回复，不要附带 Secret 值：

```text
审核人：
审核时间：
服务器活动 revision：
六个容器 revision 一致：是/否
PostgreSQL backup_id：
恢复点已复核：是/否
四项 internal smoke Secret 可用：是/否
async-internal reviewer 可用：是/否
同意仅发布代码、保持 internal、关闭 Agent Conversations：是/否
备注：
```

## 确认后的发布与验收

后端确认后，发布操作者按以下顺序执行：

1. 将已审核的本文档合入 `main` 候选，取得最终候选的完整 SHA，并再次运行确定性门禁。
2. 将同一个 `main` ref 推送到 `origin` 和 `personal`，确认两端指向同一 commit。
3. 等待协作主仓库的 `Check and build` 与 `Async durable acceptance` 成功，记录 `candidate_ci_run_id`。
4. 列出 `candidate_sha`、`candidate_ci_run_id`、后端提供的 `backup_id`、可审计的 `recovery_actor_id` 及将触发的两个 workflow，取得明确发布授权。
5. 运行 `Async internal release`，等待 Environment reviewer 审批并保存发布证据。
6. 运行 `Async internal smoke and rollback`；受控失败请求默认应得到 `DEPENDENCY_FAILURE`，intake 关闭期间新提交应得到 `ASYNC_INTAKE_CLOSED`，既有查询和同步执行应保持可用。
7. 再次确认六个容器使用最终候选 revision、`ASYNC_RELEASE_STAGE=internal`、`AGENT_CONVERSATIONS_ENABLED=false`，然后报告“代码已部署到生产 internal，Agent Conversations 尚未启用”。

任一步失败都停止后续动作，保留 PostgreSQL 数据和 additive schema，记录已完成步骤、失败门禁及自动回滚结果。重新发布前必须更新动作清单并重新取得授权。

## 不在本次范围

- 将异步流量提升到 `canary` 或 `production`；
- 开启 Agent Conversations；这还需要资源服务、模型、网关 Secret、容量门禁和专用真实 smoke；
- 运行付费 CRT 图片验收；
- 创建 tag、发布 package 或发送 release Webhook 通知。
