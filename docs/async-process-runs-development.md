# 异步 Process Run 开发指南

本文面向修改异步提交、PostgreSQL、Redis、Queue、Webhook、恢复和异步控制台的开发者。它只说明本地开发与确定性验收；当前设计见 [异步 Process Run 设计](async-process-runs-design.md)，生产操作见 [异步发布手册](async-process-runs-runbook.md)。

## 安全边界

- 首选带 `:local` 的入口。它们创建隔离 Compose project，并在成功、失败或首次中断后清理容器和临时数据。
- 手动数据库测试只使用名称以 `_test` 结尾的 PostgreSQL 数据库。
- Redis 测试只使用本机非零 database；异步 suite 会执行 `FLUSHDB`。
- 本页命令不调用模型、FAL、OSS 或生产服务。付费验收进入 [实验与真实集成](experiments.md) 或受保护 workflow。
- production migration、Queue `--apply`、内容清理和 staged release 属于运维操作，按 Runbook 执行。

## 首选验证路径

修改 Store、Outbox、Dispatcher、Worker 或 Queue 时，运行隔离的完整异步集成：

```bash
npm run test:integration:async:local
```

修改 Console Process Run Client、开发 Gateway 或页面恢复行为时，运行浏览器验收：

```bash
npm run test:acceptance:console:local
```

修改跨 Seam 契约或 CI 编排时，运行完整本地验收：

```bash
npm run test:acceptance:async:local
```

完成条件是命令自行清理依赖，并且断言只读取公共 HTTP、Client outcome 和 Process Run 状态，不穿透 PostgreSQL 布局或 BullMQ 私有字段。

## 命令选择

| 改动 | 命令 | 影响 |
| --- | --- | --- |
| PostgreSQL migration 或 Store | `npm run test:integration:postgres` | 重建明确的 `_test` schema |
| Run Observation PostgreSQL Adapter | `npm run test:integration:observation` | 访问测试数据库 |
| PostgreSQL、Redis、Outbox 与 Worker | `npm run test:integration:async:local` | 创建并删除隔离容器和数据 |
| Console 浏览器旅程 | `npm run test:acceptance:console:local` | 构建控制台；需要 Chrome |
| 全部异步验收 | `npm run test:acceptance:async:local` | 运行三层隔离验收 |
| Dispatcher/Worker 竞态 | `npm run test:drill:dispatcher-worker:local` | 注入重启、失效 claim 和重复 Job |
| Redis 全丢与 Queue 重建 | `npm run test:drill:redis-rebuild:local` | 多次清空隔离 Redis |
| Webhook 与观测隔离 | `npm run test:drill:webhook-observability:local` | 启动本地失败 Endpoint |
| Compose 生产形状 | `npm run check:deployment:async-shape` | 只渲染配置，不启动容器 |

专项 drill 可以写入 `artifacts/` 中的脱敏证据。证据只保存 revision、Run ID、状态、时间线和非秘密计数；不保存业务输入输出、连接地址、claim token、幂等键、Prompt 或凭证。

## 手动复用测试依赖

只有需要反复调试同一依赖时才手动启动 Compose：

```bash
docker compose -f compose.integration.yaml up -d --wait
export POSTGRES_TEST_DATABASE_URL=postgres://pipipi:pipipi-test-only@127.0.0.1:55432/pipipi_test
export REDIS_TEST_URL=redis://127.0.0.1:56379/15
npm run test:integration:async
docker compose -f compose.integration.yaml down
```

使用同一组 URL 的 PostgreSQL 和异步 suite 必须串行运行。并行调试时，为每个 suite 分配独立 database 和 Redis database。若进程中断后留下资源，先用 `docker compose ls` 确认准确 project，再清理该 project。

手动验证 migration 时，把测试 URL 显式传给 `DATABASE_URL`：

```bash
DATABASE_URL="$POSTGRES_TEST_DATABASE_URL" npm run db:migrate
```

应用启动不隐式修改 schema。生产 migration 使用部署角色和最小权限凭证，不复用本地测试步骤。

## 角色与调用链

异步开发形状包含 API、Process Dispatcher、Process Worker、Webhook Worker 和 Retention Cleaner。各角色从同一构建产物启动，但拥有独立 Construction Root、配置和 readiness。

```mermaid
flowchart LR
    Caller["Console Client"] --> Gateway["Development Gateway"]
    Gateway --> API["API"]
    API --> Postgres["PostgreSQL"]
    Postgres --> Dispatcher["Dispatcher"]
    Dispatcher --> Redis["BullMQ"]
    Redis --> Worker["Process Worker"]
    Worker --> Postgres
```

Queue Job 只携带 `schemaVersion` 和 `runId`。Worker 从 PostgreSQL 读取准确 Registration 与 accepted input。PostgreSQL 是权威状态；Redis 只负责调度。

需要逐角色调试时使用 `npm run dev:api`、`dev:dispatcher`、`dev:worker`、`dev:webhook-worker` 和 `dev:retention-cleaner`。完整必填配置以 `.env.example` 和 `npm run check:deployment-env -- <role>` 为准。

## 恢复、观测与清理

`npm run recover:queue -- ...` 默认 dry-run。它以 PostgreSQL Run 和 Outbox 为事实来源，报告缺失 Job、pending Outbox、活跃租约和可恢复 Run；只有明确的 `--apply` 才写 Queue、Outbox 与审计表。

`npm run observe:async` 只读 PostgreSQL 与两个 Queue，输出不含业务内容的运维快照。Dashboard 和 alert 字段由 `ops/async-observability.json` 固定。

Retention Cleaner 按 accepted input、结果、metadata 和 Webhook Delivery 历史的独立期限分批删除。测试必须固定 `asOf` 和游标；生产清理需要备份、容量和删除策略评审。

## 验证职责

- Store contract 覆盖 owner、幂等、状态转换、claim fencing 和内容过期。
- Dispatcher/Worker 覆盖 commit 后发布、重复 Job、租约接管和下游 `runId` 幂等。
- HTTP 与 Client 覆盖 `202` 丢失、同 key 恢复、owner 隔离、轮询期限和结果过期。
- Webhook 覆盖签名、稳定 event ID、独立 Queue、重试、重放和 SSRF 边界。
- 浏览器验收覆盖单次提交、accepted 进度、刷新恢复和结构化终态。

本地验证完成后仍不能直接开放生产异步入口。发布人员必须按 [异步发布手册](async-process-runs-runbook.md) 完成 migration、身份、容量、恢复、安全、观测和 staged rollout 门禁。
