# 开发指南

本文面向修改 Business Processing Service 的开发者。它说明本地开发、代码结构、常见改动路径和完成标准；项目范围与术语以 [`../CONTEXT.md`](../CONTEXT.md) 为准，发布操作见 [`mvp-release-runbook.md`](mvp-release-runbook.md)。

## 开发前提

- Node.js 24 或更高版本；
- npm 与仓库中的 `package-lock.json`；
- Direct 路径可访问的 Business Capability；
- 仅在运行 Agent 或真实模型实验时需要模型凭证；
- 仅在运行 PostgreSQL/Redis 集成测试时需要 Docker Compose。

首次安装：

```bash
npm install
cp .env.example .env
```

`.env` 已被 Git 忽略。只在本地填写真实值，不要提交、粘贴到 issue，或写入测试夹具。CI 和可复现验证优先使用 `npm ci`。

## 本地开发

终端一启动仓库内的演示 Business Capability：

```bash
npm run dev:business-api
```

终端二启动服务并监听源码变化：

```bash
npm run dev
```

复制 `.env.example` 后，Direct 模式默认连接 `http://127.0.0.1:4000`，服务监听 `3000` 端口。用以下命令确认进程和一次完整执行：

```bash
curl --fail http://127.0.0.1:3000/healthz

curl --fail -X POST http://127.0.0.1:3000/execute \
  -H 'content-type: application/json' \
  -d '{
    "process": "content-processing",
    "version": "v1",
    "input": { "content": "  local   check  " }
  }'
```

`constructProcessingService` 是生产启动的唯一 Construction Seam。它在监听端口前完成配置解析、跨字段校验、Adapter 选择和 Application 组装。启动失败时先修正配置，不要把校验移到请求路径。

## 常用命令

| 命令 | 用途 | 是否访问外部系统 |
| --- | --- | --- |
| `npm run dev` | 监听源码并启动服务 | 运行请求时访问配置的 Business Capability |
| `npm run dev:api` | 与 `dev` 相同，显式启动 API 角色 | 运行请求时访问配置的 Business Capability |
| `npm run dev:dispatcher` | 启动 Outbox Dispatcher 与 Reconciler 角色 | 是，访问 PostgreSQL 与 Redis |
| `npm run dev:worker` | 启动 Process Worker 角色 | 是，访问 PostgreSQL、Redis 与业务依赖 |
| `npm run dev:webhook-worker` | 启动 Webhook Outbox 与 Delivery Worker 角色 | 是，访问 PostgreSQL、Redis 与已注册 Endpoint |
| `npm run dev:business-api` | 启动本地演示 Business Capability | 否 |
| `npm run typecheck` | 严格 TypeScript 检查 | 否 |
| `npm test` | 运行确定性测试 | 否 |
| `npm run test:watch` | 监听并运行 Vitest | 否 |
| `npm run build` | 编译 `src/` 到 `dist/` | 否 |
| `npm run db:migrate` | 对 `DATABASE_URL` 执行受锁保护的 PostgreSQL migration | 是，会修改指定数据库 |
| `npm run test:integration:postgres` | 运行真实 PostgreSQL migration 与 Store contract tests | 是，会重建明确的 `_test` 数据库 schema |
| `npm run test:integration:async` | 运行真实 PostgreSQL、Redis、Outbox Dispatcher 与 BullMQ Worker 测试 | 是，会重建 `_test` schema 并清空指定 Redis 测试 DB |
| `npm run smoke:agent` | 验证真实 Agent 与 Business Capability | 是，可能产生模型费用 |
| `npm run smoke:staging` | 验证已部署的受控环境 | 是 |
| `npm run test:skill-ab` | 运行三组 Skill 对比 | 是，可能产生模型费用 |
| `npm run test:gpt-image-2` | 编译 Prompt、生成图片并可选上传 | 是，可能产生模型和存储费用 |
| `npm run smoke:oss` | 上传已有文件并读取首字节 | 是，会写对象存储 |

真实集成命令的配置、判据和产物见 [`experiments.md`](experiments.md)。默认测试套件不调用模型、OSS 或外部业务系统。

### PostgreSQL 集成测试

仓库提供只用于本地和 CI 的临时 PostgreSQL 17 配置。数据目录使用 `tmpfs`，测试会拒绝重建名称不以 `_test` 结尾的数据库：

```bash
docker compose -f compose.integration.yaml up -d --wait postgres
export POSTGRES_TEST_DATABASE_URL=postgres://pipipi:pipipi-test-only@127.0.0.1:55432/pipipi_test
npm run test:integration:postgres
docker compose -f compose.integration.yaml down
```

手动验证 migration 时显式把测试 URL 传给 `DATABASE_URL`：

```bash
DATABASE_URL="$POSTGRES_TEST_DATABASE_URL" npm run db:migrate
```

默认 `npm test` 不连接数据库；PostgreSQL 集成文件在缺少测试 URL 时跳过。生产 migration 必须由部署步骤使用最小权限凭证显式执行，应用启动不隐式修改 schema。

### PostgreSQL 与 Redis 异步集成测试

异步集成测试复用同一 Compose 文件，并只允许清空本机 Redis 的非零 database：

```bash
docker compose -f compose.integration.yaml up -d --wait
export POSTGRES_TEST_DATABASE_URL=postgres://pipipi:pipipi-test-only@127.0.0.1:55432/pipipi_test
export REDIS_TEST_URL=redis://127.0.0.1:56379/15
npm run test:integration:async
docker compose -f compose.integration.yaml down
```

测试证明 Outbox 在 PostgreSQL commit 后才进入统一 `process-runs` Queue，Job 只含 `schemaVersion` 和 `runId`，Worker 仍能从数据库选择准确 Registration。故障用例还覆盖 Dispatcher claim 过期、Redis 断线、重复 completed Job、Worker claim 过期接管、旧 token fencing 和停机超时 release。Compose Redis 使用 `noeviction` 和临时数据目录；它只用于测试，不代表生产高可用配置。

### 异步 HTTP 开发入口

异步路由默认关闭。启用时以下配置必须作为一个完整配置组提供：

- `ASYNC_PROCESS_RUNS_ENABLED=true` 与已完成 migration 的 `DATABASE_URL`；
- 至少 32 bytes 的 `ASYNC_GATEWAY_SHARED_SECRET`；
- `PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS`、`PROCESS_RUN_RESULT_RETENTION_MS` 和 `PROCESS_RUN_METADATA_RETENTION_MS`；
- 可选的 PostgreSQL Pool、连接超时、claim lease 和 `Retry-After` 正整数覆盖值。

可信网关必须先验证 service principal，删除外部请求中的 `x-pipipi-caller-id` 和 `x-pipipi-gateway-token`，再分别注入稳定 subject 与共享凭证。应用不接受请求 body 中的 owner，也不把身份头、共享凭证或数据库错误写入响应。`GET /healthz` 始终只做 liveness；`GET /readyz` 在异步功能启用时检查数据库连接和 `process_runs` migration。

当前已验证提交、查询、Outbox 调度、BullMQ Worker、基础故障恢复和独立运行角色。完整监控与运维门禁尚未完成；即使配置齐全也不要向外部生产流量启用该 feature flag。

### 异步运行角色

同一构建产物提供四个命令：`npm run start:api`、`npm run start:dispatcher`、`npm run start:worker` 和 `npm run start:webhook-worker`。四个角色应部署为独立进程或工作负载；API 不消费 Job，Dispatcher 不加载 Business Process 或 caller Secret，Process Worker 不加载网关身份配置，Webhook Worker 不加载 production catalog。启动后台命令本身就是启用该内部角色的部署选择；`ASYNC_PROCESS_RUNS_ENABLED` 只控制 API 是否公开异步路由。

| 配置 | API | Dispatcher | Process Worker | Webhook Worker |
| --- | --- | --- | --- | --- |
| `BUSINESS_API_BASE_URL` 与 Process 配置 | 必需 | 不读取 | 必需 | 不读取 |
| `ASYNC_PROCESS_RUNS_ENABLED` | 控制异步路由 | 不读取 | 不读取 | 不读取 |
| `ASYNC_GATEWAY_SHARED_SECRET` | 异步路由启用时必需 | 不读取 | 不读取 | 不读取 |
| `DATABASE_URL`、PostgreSQL Pool 配置 | 异步路由启用时必需 | 必需 | 必需 | 必需 |
| 三个 `PROCESS_RUN_*_RETENTION_MS` | 异步路由启用时必需 | 不读取 | 必需 | 不读取 |
| `REDIS_URL` | 不读取 | 必需 | 必需 | 必需 |
| `PROCESS_QUEUE_*` | 不读取 | 必需 | 必须与 Dispatcher 相同 | 不读取 |
| `WEBHOOK_QUEUE_*` | 不读取 | 不读取 | 不读取 | 可选覆盖 |
| `OUTBOX_*`、`PROCESS_RUN_RECONCILE_*` | 不读取 | 可选覆盖 | 不读取 | 不读取 |
| `PROCESS_WORKER_*` | 不读取 | 不读取 | 可选覆盖 | 不读取 |
| `WEBHOOK_*` | 不读取 | 不读取 | 不读取 | 可选覆盖 |
| `PORT`、`RUNTIME_ROLE_READINESS_TIMEOUT_MS` | `PORT` | 两者 | 两者 | 两者 |

部署前先执行 migration。`PROCESS_RUN_CLAIM_LEASE_MS` 必须大于 `PROCESS_TIMEOUT_MS`，避免正常 Attempt 在超时治理结束前被接管。每个环境使用独立 `PROCESS_QUEUE_PREFIX`；调用方不能提交 queue name、concurrency、retry 或 Redis 配置。

`content-processing/v1` 默认 `CONTENT_PROCESSING_RETRY_MAX_ATTEMPTS=1`。只有确认下游按 `Idempotency-Key: <runId>` 去重后，才可把该值提高到 `2`–`5`；当前只把稳定的 `DEPENDENCY_FAILURE` 分类为可重试。`CONTENT_PROCESSING_RETRY_INITIAL_DELAY_MS` 和 `CONTENT_PROCESSING_RETRY_MAX_DELAY_MS` 控制指数退避，最大延迟不超过 300 秒。等待重试时公开状态仍是 `queued`，请求 body 不能覆盖这些策略。

四个角色都提供 `GET /healthz` 和 `GET /readyz`。liveness 只确认进程工作，不访问下游；readiness 检查该角色实际使用的 migration、PostgreSQL 和 Redis，并在有界时间内返回 `503`，不暴露连接地址或内部错误。默认同步 API 保持原样，启用异步路由也不会删除 `POST /execute`。

Webhook Endpoint 由运维侧预注册并绑定 caller；Process 提交不能携带 callback URL。Webhook Worker 只发送包含 `eventId`、`runId`、准确 Process/version、终态、完成时间和相对查询位置的 payload，不复制输入、输出或内部错误。`WEBHOOK_ALLOW_INSECURE_HTTP=true` 只供隔离的本地测试；正常环境仅允许 HTTPS。Issue #20 完成前，不要向真实接收方启用该角色。

Webhook 重试状态以 PostgreSQL 为准，不依赖 BullMQ 的 Job attempts。网络错误、`429` 和 `5xx` 在 `WEBHOOK_DELIVERY_HORIZON_MS` 内按有界指数退避重试；`WEBHOOK_DELIVERY_MAX_RETRY_AFTER_MS` 限制远端 `Retry-After`，`WEBHOOK_DELIVERY_JITTER_PERCENT` 防止同步重试。默认最多 8 次 Attempt、初始等待 5 秒、单次最长等待 1 天、总投递期限 3 天。永久 `4xx` 直接失败，`410` 只停用返回该状态的 Endpoint。

每次 claim 会先创建 `started` Attempt，完成后只保存响应分类、HTTP 状态、延迟和稳定错误码，不读取或保存远端正文。运维查询必须携带 owner，并可从 run、event 或 endpoint 找到 Delivery，再查询其 Attempt。只有 `failed` 或 `exhausted` Delivery 可通过 `PostgresWebhookDeliveryStore.replay` 人工重放；调用方传入经过认证的 owner 与 operator actor。重放创建新 Delivery 和独立 Attempt 链，保留原记录与审计事件，并复用原 `eventId` 供接收方去重。

## 代码地图

| 路径 | Module 职责 |
| --- | --- |
| `src/main.ts` | 监听端口、启动日志、关闭信号和退出状态 |
| `src/startup-construction.ts` | 配置翻译、校验、Adapter 选择和生产组装 |
| `src/async-runtime-construction.ts` | Dispatcher/Worker 的角色专属配置、Adapter 和 production catalog 组装 |
| `src/webhook-runtime-construction.ts` | Webhook Outbox、Queue、Sender 和 Worker 的独立生产组装 |
| `src/application.ts` | HTTP server 的 `listen` 与 `close` 生命周期 |
| `src/runtime-role-application.ts` | 后台角色的 liveness、readiness、监听与关闭生命周期 |
| `src/http-adapter.ts` | 路由、传输校验、请求体上限、并发准入、状态码和结构化日志 |
| `src/process-runtime.ts` | Registration accept/run、Registry、同步 Runner、Attempt Runner、公共结果和错误治理 |
| `src/business-process-executor.ts` | 显式 production catalog 和 Process Runtime 组装 |
| `src/content-processing.ts` | `content-processing/v1` Registration 与 HTTP Capability Adapter |
| `src/titled-content-processing.ts` | `titled-content-processing/v1` Registration |
| `src/business-capabilities.ts` | Content Processing Capability 的窄 Interface 与依赖错误 |
| `src/agent-runtime.ts` | 受限 Pi Agent Adapter、请求级会话和唯一业务 Tool |
| `src/process-run-records.ts` | disabled、内存和持久化 Run Record Adapter 的公共语义 |
| `src/async-process-runs.ts` | 异步提交、owner 隔离、caller-scoped idempotency 和公共状态投影 |
| `src/process-run-store.ts` | 权威 Process Run Store Seam、状态转换和有界内存 Adapter |
| `src/postgres-process-run-store.ts` | PostgreSQL 事务、Attempt fencing、初始 Event 与 Outbox Adapter |
| `src/process-outbox.ts`、`src/postgres-process-outbox.ts` | Outbox claim、publish ack 与失败 release Seam/Adapter |
| `src/outbox-dispatcher.ts` | 从 PostgreSQL Outbox 向 Process/Webhook Queue 转发各自最小 Job |
| `src/process-run-reconciler.ts` | 扫描长期 queued 或过期 running Run，并通过 Queue Seam 重投 |
| `src/process-dispatcher-runtime.ts` | 以不重叠的周期运行 Outbox 与 Reconciler，并隔离可恢复错误 |
| `src/bullmq-process-work-queue.ts` | 固定版本 BullMQ Queue、Worker、Redis 连接策略与有界 Job retention |
| `src/webhook-delivery.ts`、`src/postgres-webhook-delivery-store.ts` | 终态 Delivery、原始 body 签名、HTTP 投递和持久化结果 |
| `src/bullmq-webhook-work-queue.ts` | 独立 Webhook Queue/Worker、Redis 生命周期和有界 Job retention |
| `src/caller-identity.ts` | 网关注入 caller subject 的认证与 HTTP 身份 Resolver |
| `migrations/` | 受版本和 advisory lock 管理的 PostgreSQL schema 变化 |
| `src/object-storage*.ts`、`src/aliyun-oss-storage.ts` | 通用对象存储 Seam、配置和 OSS Adapter |
| `src/openai-image-generation.ts` | 图片生成 Interface 与 OpenAI Adapter |
| `test/` | 跨公开 Seam 的确定性行为验证 |
| `examples/` | 本地依赖、真实集成 smoke 和可复现实验 |

完整 Module 关系见 [`process-runtime-design.md`](process-runtime-design.md)。图片与对象存储 Module 当前只由 `examples/` 的实验路径使用，没有进入 HTTP production catalog。

## 设计改动的工作方式

修改代码前先回答四个问题：

1. 哪些调用方需要这项行为？
2. 调用方必须知道哪些 Interface 事实？
3. 现有 Seam 能否隐藏新复杂度？
4. 哪些测试可以只通过该 Interface 证明行为？

优先加深现有 Module：减少调用方必须学习的方法、参数和顺序约束，把变化集中的规则留在 Implementation 内。设想删除该 Module；如果复杂度会重新散落到多个调用方，它提供了 Leverage 和 Locality。若复杂度直接消失，它可能只是浅层转发。

依赖由调用方注入，结果通过返回值表达。只有存在真实替换需求时才增加 Seam；生产 Adapter、受控测试 Adapter 或第二个供应商 Adapter 应共享同一个窄 Interface。不要为假想扩展点提前建立通用 Capability bag。

Interface 是测试面。测试应覆盖公开结果、invariant、错误和副作用，不读取私有 Map，不断言内部 helper 顺序，也不因等价 Implementation 重构而重写。

Process Registration 的 `accept` 解析外部输入一次，返回绑定准确 Process/version 的不可变
JSON-safe snapshot。业务 input payload 默认上限为 262144 UTF-8 bytes，序列化 Process identity
上限为 4096 bytes，完整 snapshot 上限为 266267 bytes。`run` 只执行 accepted input，不重新运行
输入 Schema；成功 output 同样必须是最大 262144 UTF-8 bytes 的 JSON-safe snapshot。同步 Process Runner 连续调用两步；需要延迟执行的内部调用方把 accepted input
持久化后，通过 Process Attempt Runner 传入预先分配的 `runId`。产品调用方不能直接提交或
修改 accepted input。

## 新增 Business Process

流程拓扑和业务语义保留在 TypeScript 中，不使用 JSON 工作流语言。维护者可以把自然语言需求直接交给 Codex；需求输入、判断规则和完整完成标准见 [`authoring-business-processes.md`](authoring-business-processes.md)。

1. 新建 `create…Registration` factory，通过 `defineProcessRegistration` 声明固定 `id`、`version`、输入 Schema、输出 Schema 和 Process Definition。
2. 把该流程获准使用的窄 Business Capability 和稳定策略传给 factory，并由闭包捕获。Execution Context 只携带 `runId` 和 `AbortSignal` 等请求级信息。
3. 用 `failProcess` 返回预期的 `AGENT_FAILURE` 或 `DEPENDENCY_FAILURE`。让意外异常继续抛出，由 Process Runner 转换为安全的 `INTERNAL_ERROR`。
4. 在 `createBusinessProcessExecutor` 的显式 production catalog 中加入 Registration。每项只代表一个准确 `(id, version)`。
5. 通过 Registration Seam 测试接受、JSON 往返、单次解析、策略和输出；通过 Process Attempt Runner 测试预分配 `runId`、超时与错误净化；通过真实本地 `/execute` 测试产品行为和 HTTP 映射。
6. 更新 README 的当前能力、`CONTEXT.md` 的产品契约，以及受影响的设计或发布文档。

[`src/titled-content-processing.ts`](../src/titled-content-processing.ts) 是最小示例。新版本必须新建 Registration 并显式加入 catalog；不要加入 `latest`、默认版本、自动发现或回退。

流程需要外部 Skill 时，先按 [`integrating-runtime-skills.md`](integrating-runtime-skills.md) 在开发期解析、审查和固定来源。Process Registration 只绑定随应用发布的本地 Runtime Skill，不接收路径或 URL。

## 修改外部依赖

远程协议、供应商 SDK、认证、重试和响应解析属于 Adapter 的 Implementation。Process Definition 只依赖窄 Business Capability Interface，并只看领域结果或净化后的依赖错误。

新增或更换 Adapter 时：

1. 先保持现有 Interface，确认新需求确实属于同一业务能力。
2. 在 Adapter 内完成超时、取消、响应 Schema 和供应商错误转换。
3. 用受控本地 server 或 fake Adapter 验证，不在默认测试中访问真实远端。
4. 只在 Startup Construction 或明确的 composition root 选择生产 Adapter。
5. 若新供应商迫使调用方理解其专有概念，重新检查 Seam 是否放错位置。

## 接入 Run Record

默认生产构造使用 disabled 实现，只输出结构化完成日志。开发或单实例测试可以注入有容量上限的内存实现：

```ts
import { createProcessingApplication } from "./src/application.js";
import { createBusinessProcessExecutor } from "./src/business-process-executor.js";
import { createInMemoryProcessRunRecords } from "./src/process-run-records.js";

const runRecords = createInMemoryProcessRunRecords({ maxRecords: 100 });
const executor = createBusinessProcessExecutor({
  contentProcessing,
  runRecords,
});
const application = createProcessingApplication({ executor });

const record = await runRecords.find(runId);
```

内存记录按写入顺序淘汰，进程重启后丢失，也不在实例间共享。生产持久化应实现 `ProcessRunRecordAdapter`，再通过 `createProcessRunRecords({ adapter })` 接入数据库或可观测平台；Adapter 写入失败不能改变 Process Run 结果。

默认内容策略为 `omit`。只有完成数据授权、租户隔离、脱敏和保留期限评审后，才设置 `content: "accepted-input-and-output"`。该策略只接收已被 Registration 接受的输入和成功输出，不保存无效请求、Prompt、Tool 过程、模型消息或隐藏推理。

Run Record 是运行排障数据，不是聊天历史。产品聊天记录应由业务数据库按用户与会话保存，并把 `runId` 作为关联键。若要公开 Run Record 查询，先设计调用方认证、租户隔离和内容访问策略。

## 配置规则

[`.env.example`](../.env.example) 是配置键的可复制清单；解析函数和测试约束精确默认值与组合规则。

- 新增配置时同时更新 `.env.example`、启动构造测试和相关文档。
- 只把稳定运行策略放入环境配置。Process 拓扑、Schema 和业务语义留在代码中。
- 成组配置在启动时一起校验。例如 `PI_PROVIDER` 与 `PI_MODEL` 必须同时设置。
- 异步功能关闭时忽略数据库和网关专用配置；启用后缺少任一必需值都在监听前失败。
- Direct 模式不应因无关的 Agent 配置失败。
- `.env.example` 把 `PROCESS_TIMEOUT_MS` 设为 `120000`，用于受控发布形状；未设置变量时，代码默认值仍为 `30000`。
- Secret 只由本地 `.env` 或部署平台注入。日志和错误响应不得包含凭证、Base URL、远端正文或模型错误。

## 测试策略

按风险从窄到宽验证：

1. 在改动附近运行单个测试文件，例如 `npm test -- test/process-runtime.test.ts`。
2. 运行 `npm run typecheck` 和 `npm test`。
3. 修改构建、入口或发布资源时运行 `npm run build`；修改镜像时再构建 Docker image。
4. 只有确定性验证通过后，才运行需要凭证、网络或费用的 smoke。

测试职责保持清晰：

- Startup Construction 测试配置解析、跨字段拒绝和完整生产组装。
- Process Runtime 测试 Registration、Registry、Process Attempt Runner 和同步 Runner 的 Interface invariant。
- HTTP Adapter 测试传输错误、容量、状态码和结构化日志。
- Application 测试 server 生命周期，不了解具体 Business Process。
- Process Registration 测试流程 Schema、获准依赖、策略和错误契约。
- Adapter 测试协议与错误转换；默认使用本地受控依赖。

修复缺陷时先增加能跨正确 Seam 复现问题的测试。若只能穿透 Interface 才能验证，先重新检查 Module 形状。

## 完成标准

一项开发改动完成时应满足：

- Interface 比改动前更清楚，或至少没有把 Implementation 知识推给调用方；
- 预期失败有稳定错误码，意外失败不会泄露内部消息；
- 确定性测试覆盖成功、拒绝和关键 invariant；
- `npm run typecheck`、`npm test` 和受影响的构建检查通过；
- 配置样例、项目说明、设计文档和 Runbook 与代码保持一致；
- 不含 `.env`、真实业务内容、签名 URL、模型过程或其他敏感产物。
