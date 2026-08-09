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
| `npm run dev:business-api` | 启动本地演示 Business Capability | 否 |
| `npm run typecheck` | 严格 TypeScript 检查 | 否 |
| `npm test` | 运行确定性测试 | 否 |
| `npm run test:watch` | 监听并运行 Vitest | 否 |
| `npm run build` | 编译 `src/` 到 `dist/` | 否 |
| `npm run db:migrate` | 对 `DATABASE_URL` 执行受锁保护的 PostgreSQL migration | 是，会修改指定数据库 |
| `npm run test:integration:postgres` | 运行真实 PostgreSQL migration 与 Store contract tests | 是，会重建明确的 `_test` 数据库 schema |
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

### 异步 HTTP 开发入口

异步路由默认关闭。启用时以下配置必须作为一个完整配置组提供：

- `ASYNC_PROCESS_RUNS_ENABLED=true` 与已完成 migration 的 `DATABASE_URL`；
- 至少 32 bytes 的 `ASYNC_GATEWAY_SHARED_SECRET`；
- `PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS`、`PROCESS_RUN_RESULT_RETENTION_MS` 和 `PROCESS_RUN_METADATA_RETENTION_MS`；
- 可选的 PostgreSQL Pool、连接超时、claim lease 和 `Retry-After` 正整数覆盖值。

可信网关必须先验证 service principal，删除外部请求中的 `x-pipipi-caller-id` 和 `x-pipipi-gateway-token`，再分别注入稳定 subject 与共享凭证。应用不接受请求 body 中的 owner，也不把身份头、共享凭证或数据库错误写入响应。`GET /healthz` 始终只做 liveness；`GET /readyz` 在异步功能启用时检查数据库连接和 `process_runs` migration。

当前批次只验证提交与查询。Outbox Dispatcher 和 BullMQ Worker 完成前，即使配置齐全也不要向生产流量启用该 feature flag。

## 代码地图

| 路径 | Module 职责 |
| --- | --- |
| `src/main.ts` | 监听端口、启动日志、关闭信号和退出状态 |
| `src/startup-construction.ts` | 配置翻译、校验、Adapter 选择和生产组装 |
| `src/application.ts` | HTTP server 的 `listen` 与 `close` 生命周期 |
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
