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

复制 `.env.example` 后，Direct 模式默认连接 `http://127.0.0.1:4000`，服务监听 `4300` 端口。用以下命令确认进程和一次完整执行：

```bash
curl --fail http://127.0.0.1:4300/healthz

curl --fail -X POST http://127.0.0.1:4300/execute \
  -H 'content-type: application/json' \
  -d '{
    "process": "content-processing",
    "version": "v1",
    "input": { "content": "  local   check  " }
  }'
```

`constructProcessingService` 是生产启动的唯一 Construction Seam。它在监听端口前完成配置解析、跨字段校验、Adapter 选择和 Application 组装。启动失败时先修正配置，不要把校验移到请求路径。

### 新闻图片内部评测

设置 `INTERNAL_EVAL_ENABLED=true` 后，可调用 `POST /internal/eval/execute`；生产当前已开启。该调用会访问文本模型、图片供应商和对象存储，产生费用和外部写入。该入口不实现独立鉴权，鉴权与 `/execute` 一并后续统一处理；在此之前入口网关必须放行该路径，否则网关会先返回 `401`。完整请求、响应和错误契约见[内部新闻图片评测接口](api.md#内部新闻图片评测)。

## 常用命令

日常开发只需要以下入口：

| 命令 | 用途 | 外部影响 |
| --- | --- | --- |
| `npm run dev` | 监听源码并启动同步 API | 请求时访问配置的 Business Capability |
| `npm run dev:business-api` | 启动确定性的本地演示 Capability | 无 |
| `npm run dev:console` | 启动 Vite 控制台 | 需要另行启动 API |
| `npm run check` | 只读检查格式、lint 和 import 顺序 | 无 |
| `npm run check:fix` | 应用 Biome 格式和安全修复 | 修改工作区 |
| `npm run typecheck` | 检查服务端与控制台 TypeScript | 无 |
| `npm test` | 运行确定性测试 | 无 |
| `npm run test:watch` | 监听并运行 Vitest | 无 |
| `npm run build` | 构建服务端与控制台 | 重建 `dist/` |

修改异步执行、PostgreSQL、Redis、Queue、Webhook、恢复或控制台异步提交时，转到 [异步 Process Run 开发指南](async-process-runs-development.md)。真实 Agent、图片、模型、OSS 和已部署环境验证转到 [实验与真实集成](experiments.md)。生产配置检查、migration、恢复和发布操作按对应 Runbook 执行。

`package.json` 是脚本名称的事实来源。开发文档只保留选择依据、危险边界和环境无法表达的约束，不复制完整脚本清单。

## 常见问题

| 现象 | 先检查 | 下一步 |
| --- | --- | --- |
| `npm run dev` 启动失败 | Node.js 版本、`.env` 和启动错误中的配置名 | 对照 [配置规则](#配置规则) 与 `.env.example` |
| `/healthz` 可用但执行失败 | `npm run dev:business-api` 是否运行、`BUSINESS_API_BASE_URL` 是否指向本地服务 | 用本页的 Direct 请求复现 |
| PostgreSQL 或 Redis 测试跳过 | 对应测试 URL 是否设置 | 阅读 [异步开发指南](async-process-runs-development.md) |
| 浏览器验收找不到 Chrome | 本机 Chrome 路径 | 设置 `CHROME_PATH=/absolute/path` |
| 图片或 Agent 验收失败 | 是否明确提供凭证并批准费用和外部写入 | 阅读 [实验与真实集成](experiments.md) |
| 构建通过但部署预检失败 | 是否已构建、目标角色是否完整注入 Secret | 阅读对应发布 Runbook |

## 代码地图

`src/` 按拥有行为的 Module 分组。目录表达代码所有权；Adapter 与其实现的 Interface 保持在同一 Module 内。

| 目录 | Module 职责 |
| --- | --- |
| `src/bin/` | API、CRT Business API、Dispatcher、Worker、Cleaner、Operations、Recovery 和 Availability Monitor 的可执行入口；不放业务规则 |
| `src/app/` | 各可执行角色的 Composition Root、启动配置和后台角色生命周期；只做环境翻译与 Adapter 选择，不拥有可独立测试的行为 |
| `src/api/` | HTTP Application、路由、caller identity、控制台 Process 目录投影和文件控制的异步 intake 开关；不组装业务与基础设施 |
| `src/run-observation/` | 同步与异步 Run 共用的运维观测：Run Record 归档、Attempt 活动归档、统计汇总，以及 JSONL 与 PostgreSQL 两套 Adapter 和 Pino 活动日志 Sink；只供操作者查看，不决定业务状态 |
| `src/release/` | 发布门禁逻辑：异步 internal smoke、付费 CRT 异步 smoke、新闻图片业务验收、smoke 状态审计、生产数据库身份审计和 migration 二次验证；只由 `bin/`、`examples/` 和 CI 调用，不进入请求路径 |
| `src/process-runtime/` | 跨 Business Process 复用的 Registration、Registry、Runner、Attempt、结果和观测治理 |
| `src/agent-runtime/` | 跨 Business Process 复用的 Pi provider 配置、无 Tool Structured Agent Session、Agent JSON 解析、Installed Skill Catalog 和 Runtime Skill 精确加载 |
| `src/processes/` | production catalog，以及按 `content/`、`titled-content/`、`poster/`、`crt/`、`news-image/` 分组的具体 Business Process；不放通用 Runtime |
| `src/process-runs/` | Async Process Runs，以及按 `store/`、`queue/`、`outbox/`、`worker/`、`recovery/`、`retention/` 和 `ops/` 分组的内部 Module |
| `src/webhooks/` | Webhook Delivery，以及按 `delivery/`、`store/`、`queue/`、`outbox/` 分组的内部 Module |
| `src/availability/` | 一次性 Availability Monitor、HTTP/Redis Probe 和异常 Webhook Notifier |
| `src/network/` | 跨 Adapter 复用的公网地址校验、DNS 解析与 IP-pinned HTTP transport；不拥有业务重试或 payload 语义 |
| `src/business-api/` | CRT Business API、FAL、finalizer、证据和对象存储 Adapter |
| `migrations/` | 受版本和 advisory lock 管理的 PostgreSQL schema 变化 |
| `test/` | 跨公开 Seam 的确定性行为验证 |
| `examples/` | 本地依赖、真实集成、业务验收和可复现实验 |

关键 Interface 和 Composition Root 位于：

| 路径 | 职责 |
| --- | --- |
| `src/bin/api.ts`、`dispatcher.ts`、`process-worker.ts`、`webhook-worker.ts`、`retention-cleaner.ts` | 分别调用对应 `app/` Composition Root 构造角色服务并监听端口 |
| `src/bin/operations.ts`、`recover.ts`、`availability-monitor.ts` | 分别构造 Operations、Recovery、Availability Monitor 命令，执行一次性运维操作并输出报告 |
| `src/bin/check-deployment-environment.ts` | 校验指定部署角色所需环境变量（及生产环境下的 Runtime Skill 绑定），用于部署前检查 |
| `src/bin/migrate-and-verify.ts` | 通过 node-pg-migrate 执行数据库迁移并验证结果 |
| `src/bin/audit-production-database.ts`、`audit-async-smoke-state.ts` | 连接生产数据库分别采集审计证据、审计异步冒烟测试状态（支持等待投递覆盖完成） |
| `src/bin/crt-business-api.ts` | 校验部署环境后装配 CRT 图像生成、对象存储与证据策略，启动 CRT Business API |
| `src/app/api.ts` | API 配置翻译、校验、Adapter 选择和完整生产组装 |
| `src/app/business-processes.ts` | production Business Process Runtime 与 catalog 依赖组装 |
| `src/app/runtime-skills.ts` | 七个 Runtime Skill 的生产安装集合、启动完整性校验和精确 Process 绑定 |
| `src/app/run-observation.ts`、`postgres-pool.ts` | 按环境选择 JSONL 或 PostgreSQL 观测 Adapter；从启动环境构造各角色共用的 pg Pool |
| `src/app/process-dispatcher.ts`、`process-worker.ts`、`retention-cleaner.ts` | 各后台角色独立的配置和 Adapter 组装 |
| `src/app/process-recovery.ts`、`async-operations.ts` | 一次性运维命令的资源组装 |
| `src/app/webhook-worker.ts` | Webhook Worker 的 Delivery、Outbox、Queue 和 HTTP Sender 组装 |
| `src/app/availability-monitor.ts` | Availability Monitor 的 Probe、Notifier 与部署配置组装 |
| `src/app/config.ts` | 从启动环境字符串解析端口、正整数、布尔值、连接 URL 等基础配置值并校验合法性 |
| `src/app/deployment-environment.ts` | 按 Role 声明并校验部署所需的环境变量，缺失或生产环境不合规时报错 |
| `src/app/process-run-config.ts` | 解析 Process Runner 所需的数据库、Redis 连接及队列命名配置 |
| `src/app/role.ts` | 为后台 Role 组装健康检查、就绪探测的 HTTP Runtime，并管理其生命周期 |
| `src/release/news-image-acceptance.ts` | 三个新闻图片 Process 的真实 HTTP/OSS 验收、下载限制、PNG 检查和无 URL 证据投影 |
| `src/release/async-internal-smoke.ts`、`paid-async-image-smoke.ts`、`async-smoke-state.ts` | 异步网关 smoke 与回滚验证、受控付费 CRT 异步 smoke，以及 smoke 之后的数据库状态审计 |
| `src/release/production-database-audit.ts`、`migration-verification.ts` | 生产数据库身份、TLS 与最小权限审计；migration 应用后的二次空跑验证 |
| `src/api/process-catalog.ts`、`async-intake.ts` | 从 Registration Schema 推导控制台 Process 目录；文件标记控制的 `POST /process-runs` intake 开关 |
| `src/api/application.ts` | 组装 HTTP Server 生命周期，把监听/关闭封装成 Processing Application |
| `src/api/http.ts` | Composition Root：按路由把执行、异步 Process Run、控制台 Run Record 查询分发给各协作者 |
| `src/api/console-assets.ts` | 从构建产物目录按白名单模式提供控制台文档与静态资源 |
| `src/api/identity.ts` | 网关共享密钥 Seam 的唯一 Adapter：校验请求头并解析 caller identity |
| `src/api/public-documents.ts` | 缓存并按固定路径提供随版本发布的只读文档（如 `llms.txt`） |
| `src/run-observation/records.ts`、`activities.ts`、`stats.ts` | Run Record 归档、活动归档与统计汇总的 Interface，以及两套 Adapter 共用的游标、分页上限、净化和聚合规则；`stats.ts` 拥有 `RunObservationSummary` |
| `src/run-observation/jsonl.ts`、`postgres.ts` | 同一组 Interface 的 JSONL Adapter（含按 UTC 日分片的 `day-files.ts` 内部 Seam）与 PostgreSQL Adapter |
| `src/run-observation/pino.ts` | 带脱敏的 Pino 活动日志 Sink |
| `src/process-runtime/registration.ts` | 定义 Process Registration：校验输入输出 Schema、快照化 JSON、声明可用活动与重试策略，产出可执行的 Registration |
| `src/process-runtime/registry.ts` | 按 id/version 索引 Process Registration 集合，提供按身份查找与全量有序列表 |
| `src/process-runtime/runner.ts` | 组合 Registry、Attempt Runner 与 Run Records，校验请求并派发执行，对外提供 execute/evaluate 入口 |
| `src/process-runtime/attempt.ts` | 以超时和外部取消竞速执行单次 Process Attempt，产出 Run Record 并驱动 Attempt 日志 |
| `src/process-runtime/logging.ts` | 定义 Process Run 日志事件结构，创建单次 Attempt 的活动日志并支持多 Sink 合并，日志失败不影响执行结果 |
| `src/process-runtime/records.ts` | 定义 Process Run Record 及其存取接口，提供禁用与内存两种 Adapter，记录失败不影响执行结果 |
| `src/process-runtime/result.ts` | 定义 Process Run 的成功/失败结果类型（`ProcessRunResult`）与公开错误码，提供失败结果构造函数 |
| `src/process-runtime/index.ts` | process-runtime 模块的公开导出入口，收拢 Attempt/Registry/Registration/Runner/Records/日志/结果类型 |
| `src/agent-runtime/catalog.ts`、`pi.ts`、`skills.ts`、`structured.ts` | 多个流程共用的启动期 Skill 完整性与版本 Catalog、Pi provider 配置、Runtime Skill 精确加载，以及海报、CRT 与新闻图片共用的无 Tool Structured Agent Session |
| `src/processes/catalog.ts` | 显式 production catalog 和 Process Runtime 组装 |
| `src/processes/content/registration.ts` | `content-processing/v1` 的 Schema、Direct/Agent 流程、失败和 Tool 调用 invariant |
| `src/processes/content/skills.ts` | `content-processing/v1` 获准使用的有序 Runtime Skill 集合与 Tool 名称 |
| `src/processes/content/agent.ts`、`agent.pi.ts` | 窄 Content Agent Port，以及它的生产 Pi 实现 |
| `src/processes/content/capability.ts`、`capability.http.ts` | Content Processing Capability Port、内容处理契约与它的生产 HTTP 实现 |
| `src/processes/content/config.ts` | Business API Base URL 的解析与校验 |
| `src/processes/titled-content/registration.ts` | Titled Content Processing Process Registration，拼接标题与正文后调用 Content Processing Capability |
| `src/processes/poster/registration.ts` | `minimal-zine-poster/v1` 的 Schema、Prompt 校验、执行顺序和稳定失败 |
| `src/processes/poster/agent.ts`、`agent.pi.ts` | 无 Tool 的 Poster Agent Port 与它的 Pi Prompt 编译实现 |
| `src/processes/poster/capability.ts`、`capability.http.ts` | Poster Rendering Capability Port、图片引用契约与它的生产 HTTP 实现 |
| `src/processes/poster/skills.ts` | `minimal-zine-poster/v1` 绑定的准确 Runtime Skill |
| `src/processes/crt/registration.ts` | `crt-interface-image/v1` 的上传资产引用、Prompt/recipe 校验、顺序和稳定失败 |
| `src/processes/crt/agent.ts`、`agent.pi.ts` | 看不到参考图和资产标识的无 Tool CRT Agent Port 与它的 Pi 实现 |
| `src/processes/crt/capability.ts`、`capability.http.ts` | CRT Rendering Capability Port、PNG 引用契约与它的 `POST /crt-images` 实现 |
| `src/processes/crt/style.ts`、`skills.ts` | 固定调色板、画幅和准确 Runtime Skill 绑定 |
| `src/processes/news-image/registration.ts` | 三个新闻图片 Process 共用的 Registration 工厂：按固定风格选择 Prompt 契约校验规则，编排 Prompt 编译与渲染活动并处理失败 |
| `src/processes/news-image/capability.ts`、`capability.http.ts` | News Image Rendering Capability Port 的图片/生成参数契约，以及它的 `POST /news-images` 生产 HTTP 实现 |
| `src/processes/news-image/agent.ts`、`agent.pi.ts` | 窄 News Image Agent Port，以及它无 Tool 的 Pi Prompt 编译实现 |
| `src/processes/news-image/skills.ts` | 三个新闻图片风格各自绑定的准确 Runtime Skill |
| `test/news-image-process.test.ts` | 三个新闻图片 Process 的输入归一化、固定风格、单次渲染、输出隐藏和稳定失败回归 |
| `test/news-image-business-acceptance.test.ts` | 三个固定 Process 的单次验收、OSS 位置、重定向拒绝和证据净化 |
| `src/process-runs/index.ts` | 异步提交、owner 隔离、caller-scoped idempotency 和公共状态投影 |
| `src/process-runs/dispatcher.ts` | 编排 Outbox 派发与 Run 对账两个周期性循环，统一控制启动、就绪与关闭 |
| `src/process-runs/store/index.ts`、`src/process-runs/store/postgres.ts` | 权威状态转换，以及内存和 PostgreSQL Adapter |
| `src/process-runs/queue/index.ts`、`src/process-runs/queue/bullmq.ts` | 最小 Job Interface，以及内存和 BullMQ Adapter |
| `src/process-runs/queue/observability.ts` | 读取 BullMQ 队列各状态计数与最旧可运行 Job 的堆积时长，生成可观测快照 |
| `src/process-runs/outbox/index.ts`、`postgres.ts` | Process Outbox 的认领/标记已发布/释放接口，及基于 Postgres 行锁的实现 |
| `src/process-runs/outbox/dispatcher.ts` | 从 Outbox 认领消息并投递到队列，成功标记已发布、失败释放认领（Process 与 Webhook Outbox 共用） |
| `src/process-runs/recovery/index.ts`、`src/process-runs/recovery/postgres.ts` | 周期 reconciliation、人工 Queue Recovery，以及恢复候选的 PostgreSQL Adapter |
| `src/process-runs/recovery/command.ts` | 解析 Queue Recovery 命令行参数并驱动 reconciler 分批执行对账/恢复 |
| `src/process-runs/retention/index.ts`、`postgres.ts` | 按批次驱动 Postgres 保留期清理并封装为周期性 Runtime（含游标续跑），及分批清理过期 Run 数据的 Postgres 实现 |
| `src/process-runs/worker/index.ts` | 认领并执行单个 Process Run 的 Job，处理成功/失败/重试并落地终态观测记录 |
| `src/process-runs/ops/postgres.ts` | 异步运维快照和 staged release readiness 的 PostgreSQL Adapter |
| `src/process-runs/ops/logging.ts` | 定义异步操作日志的记录类型与安全发送/输出工具函数 |
| `src/webhooks/delivery/http.ts` | 用 Standard Webhooks 签名和目标策略发起签名 HTTP 投递，产出成功/失败结果 |
| `src/webhooks/delivery/signing.ts` | 生成和校验 Standard Webhooks HMAC 签名及 `whsec_` 密钥格式 |
| `src/webhooks/delivery/target-policy.ts` | 基于公网 HTTP 目标策略解析并 Pin 住 Webhook 投递目标地址，拒绝内网/不安全目标 |
| `src/webhooks/delivery/job.ts` | 定义并解析 Webhook Delivery Job 载荷 |
| `src/webhooks/delivery/worker.ts` | Delivery Worker：认领投递、调用 Sender 发送、按重试策略计算退避并重新调度或终结投递 |
| `src/webhooks/delivery/index.ts` | 汇总导出 delivery 目录下的公共类型和工厂函数 |
| `src/webhooks/store/postgres.ts` | Endpoint、Delivery、Attempt 和 replay 的 PostgreSQL Adapter |
| `src/webhooks/store/secret-cipher.ts` | 用 AES-256-GCM 信封加密对 Webhook Endpoint 签名密钥做加解密 |
| `src/webhooks/queue/index.ts` | 定义 Webhook Work Queue/Source 接口，并提供内存实现用于测试 |
| `src/webhooks/queue/bullmq.ts` | 基于 BullMQ 实现 Webhook Work Queue 入队去重和 Delivery Worker 的并发消费与优雅关闭 |
| `src/webhooks/outbox/index.ts`、`postgres.ts` | Webhook 事务 Outbox 的认领/发布/释放接口，及基于 Postgres 行锁的实现 |
| `src/webhooks/runtime.ts` | 编排 Outbox 派发定时器与 Delivery Worker 的启动、就绪检查和优雅关闭 |
| `src/network/public-http.ts` | 公网目标校验、全部 DNS 地址检查、固定 IP 连接和有界响应读取 |
| `src/availability/monitor.ts` | Availability Monitor 的 Interface 定义、Probe 编排与聚合状态判定 |
| `src/availability/http.ts` | 内部与公网 HTTP 服务的 Availability Probe |
| `src/availability/redis.ts` | Redis 的 Availability Probe，检测连接、配置与安全基线 |
| `src/availability/webhook.ts` | 飞书机器人 Webhook 的 Availability Notifier |
| `src/business-api/object-storage.ts`、`aliyun-oss-storage.ts`、`object-storage-config.ts` | 对象存储 Interface（`ObjectStorageCapability`）、阿里云 OSS Adapter 与环境变量装配 |
| `src/business-api/openai-image-generation.ts`、`openai-image-config.ts` | OpenAI 图片生成/编辑 Adapter 与其 API Key/Base URL 装配 |
| `src/business-api/fal-image-generation.ts`、`image-generation-config.ts` | FAL（GPT Image 2）图片生成/编辑 Adapter，及按 `IMAGE_PROVIDER` 选择 Adapter 的装配 Interface |
| `src/business-api/crt-finalizer.ts`、`crt-evidence.ts` | CRT 图像后处理（像素化/扫描线/调色板渲染）与渲染证据留存 |
| `src/business-api/crt-server.ts` | CRT Business API 本地 HTTP 服务：编排图片编辑/生成、幂等与结果落盘、CRT 终稿与新闻图渲染、对象存储上传与错误归因 |

依赖方向固定为：`bin` 只进入 `app` 与 `release`；`app` 组装 `api`、`processes`、`process-runs`、`webhooks` 和 `run-observation`；`release` 只依赖 `processes` 的公开契约与注入的 HTTP/数据库句柄；`run-observation` 只依赖 `process-runtime` 的稳定 Interface；具体 `processes` 依赖 `process-runtime` 与 `agent-runtime`，`process-runs` 只依赖 `process-runtime` 的稳定 Interface，`api` 只依赖 `process-runtime` 的稳定 Interface 和 `run-observation` 拥有的汇总类型。Runtime Module 不反向引用具体 Business Process，领域与业务 Module 不反向引用 `app` 或 `bin`；Composition Root 负责把它们连接起来。

顶层目录使用明确的领域名，子目录对应实际 Module。父目录已经提供的上下文不在文件名中重复，例如使用 `src/process-runs/store/postgres.ts`，不用 `src/process-runs/store/postgres-process-run-store.ts`；Adapter 文件只保留 `postgres.ts`、`bullmq.ts`、`http.ts` 等技术名称；当同一 Module 内有多个 Port 各带 Adapter 时，用 `<port>.<技术>.ts` 让配对显形，例如 `agent.ts`/`agent.pi.ts` 与 `capability.ts`/`capability.http.ts`。不要新增 `common/`、`shared/`、`utils/` 或横向的 `controllers/services/repositories` 目录。无法明确归属的代码应先重新检查 Module 和 Seam。

完整 Module 关系见 [`process-runtime-design.md`](process-runtime-design.md)。海报与 CRT Business Process 及其受控 HTTP Adapter 已进入 production catalog；供应商专用的 OpenAI Images 与阿里云 OSS Adapter 仍只由 `examples/` 中的显式集成和业务验收使用。各 Process 的独立入口见 [`processes/`](processes/)；CRT 的上传、后处理和完整发布门禁见 [`processes/common/crt-interface-image/`](processes/common/crt-interface-image/)。

## 命名规则

名称应在使用点直接表达角色，并尽可能短。不要把目录、类型和调用链重复拼进同一个标识符。新代码和本次触达的旧代码遵守以下规则；其他旧名在相关 Module 发生修改时逐步整理。

### 利用作用域

- 目录和文件已经表达的领域不在私有名称中重复。`content/registration.ts` 使用 `RegistrationOptions`，不用 `ContentProcessingRegistrationOptions`。
- 跨 Module 导出保留“必要领域词 + 角色”。例如 `PiContentAgent` 同时说明 Adapter 和角色；`Agent` 太宽，`PiContentOptimizationAgentRuntime` 重复过多。
- 同一文件内优先使用 `mode`、`config`、`inputMaxBytes` 等短名。出现导入冲突时在导入处使用别名，不给所有声明添加前缀。
- 集合使用复数名，布尔值使用 `is`、`has`、`can` 或 `should` 前缀。名称必须描述值，不描述它的历史来源。

### 使用准确动词

| 动词 | 用途 |
| --- | --- |
| `create` | 在内存中创建并返回 Module、Adapter 或值 |
| `load` | 从文件、环境或远端读取数据 |
| `parse` | 校验并转换外部表示，失败时抛出明确错误 |
| `find` | 查询可能不存在的值 |
| `require` | 查询必需值，缺失时失败 |
| `run`、`execute` | 执行业务或运行时行为 |

避免用 `construct`、`handle`、`manage`、`do` 或 `process` 掩盖更具体的动作；领域本身把 `process` 定义为动作时可以保留。Factory 统一使用 `create`，不要只靠 `build`、`make`、`construct` 的细微差别区分相邻函数。

### 控制长度

- 私有或局部名称超过 24 个字符、导出名称超过 32 个字符时必须复核。这个长度是评审触发线，不是硬限制。
- 删除不能帮助当前调用点区分含义的词。若删除后产生歧义，优先调整 Module 或导入别名，再考虑增加限定词。
- 可以使用行业通用缩写：`id`、`url`、`http`、`api`、`json`、`sql`、`db`、`ms`。禁止使用 `mgr`、`cfg`、`proc` 等需要猜测的自造缩写。
- `Options`、`Config`、`Result`、`Adapter` 等后缀只有在表达真实角色时保留。文件内只使用一次的参数类型可以保持私有并命名为 `Options` 或 `RegistrationOptions`。

本次整理提供以下基准：

| 原名称 | 新名称 | 理由 |
| --- | --- | --- |
| `PiContentOptimizationAgentRuntime` | `PiContentAgent` | 所属 Module 与 Pi Adapter 已表达 Runtime 上下文 |
| `constructBusinessProcessRuntime` | `createProductionRuntime` | 直接说明它创建生产 Runtime |
| `createBusinessProcessRuntime` | `createProcessRuntime` | `Process` 已是仓库共同语言 |
| `createContentProcessingRegistration` | `createContentRegistration` | 返回角色保留，目录上下文删除 |
| `acceptedProcessInputPayloadMaxBytes` | `inputMaxBytes` | 私有常量无需重复 Registration 上下文 |

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

1. 从 [Business Process 场景目录](processes/README.md) 确认 `memene`、`memebuy` 或 `common`，并读取目标场景 README。
2. 新建 `create…Registration` factory，通过 `defineProcessRegistration` 声明固定 `id`、`version`、输入 Schema、输出 Schema、运行活动和 Process Definition。
3. 把该流程获准使用的窄 Business Capability 和稳定策略传给 factory，并由闭包捕获。流程使用 Agent 时，在流程 Module 内定义准确、有序的 Skill 与 Tool 集合；Composition Root 只提供 Adapter 和部署配置。Execution Context 只携带 `runId`、`AbortSignal` 和受控 `runActivity` 等请求级信息。
4. 用 `failProcess` 返回预期的 `AGENT_FAILURE` 或 `DEPENDENCY_FAILURE`。让意外异常继续抛出，由 Process Runner 转换为安全的 `INTERNAL_ERROR`。
5. 在 `createProcessExecutor` 的显式 production catalog 中加入 Registration。每项只代表一个准确 `(id, version)`。
6. 通过 Registration Seam 测试接受、JSON 往返、单次解析、策略和输出。Agent 流程还要验证 Tool 调用次数、下游幂等键和最终结果来源；通过 Process Attempt Runner 测试预分配 `runId`、超时、活动时间线、日志故障隔离与错误净化；通过真实本地 `/execute` 测试产品行为和 HTTP 映射。
7. 创建或更新 `docs/processes/<scenario>/<process-id>/README.md` 和所属场景 README，再更新 README 的当前能力、`CONTEXT.md` 的产品契约，以及受影响的设计或发布文档。

[`src/processes/titled-content/registration.ts`](../src/processes/titled-content/registration.ts) 是最小示例；[`src/processes/poster/registration.ts`](../src/processes/poster/registration.ts) 展示 Agent 编译后再调用 Business Capability 的两阶段流程；[`src/processes/crt/registration.ts`](../src/processes/crt/registration.ts) 展示如何把预上传资产保持为不透明业务字段。新版本必须新建 Registration 并显式加入 catalog；不要加入 `latest`、默认版本、自动发现或回退。

流程需要外部 Skill 时，先按 [`integrating-runtime-skills.md`](integrating-runtime-skills.md) 在开发期解析、审查和固定来源。Process Registration 可以绑定一个或多个随应用发布的本地 Runtime Skill；完整集合必须一起评审。产品请求不接收 Skill 名称、路径或 URL。

## 修改外部依赖

远程协议、供应商 SDK、认证、重试和响应解析属于 Adapter 的 Implementation。Process Definition 只依赖窄 Business Capability Interface，并只看领域结果或净化后的依赖错误。

新增或更换 Adapter 时：

1. 先保持现有 Interface，确认新需求确实属于同一业务能力。
2. 在 Adapter 内完成超时、取消、响应 Schema 和供应商错误转换。
3. 用受控本地 server 或 fake Adapter 验证，不在默认测试中访问真实远端。
4. 只在 Startup Construction 或明确的 composition root 选择生产 Adapter。
5. 若新供应商迫使调用方理解其专有概念，重新检查 Seam 是否放错位置。

## 追踪 Process Run 活动

Production Composition Root 默认通过 Pino Adapter 把 Process Attempt 与活动日志写成 newline-delimited JSON。Process author 在 Registration 中声明固定活动，并用 Execution Context 包住有业务意义、可能耗时或失败的操作：

```ts
return defineProcessRegistration({
  id: "example-processing",
  version: "v1",
  inputSchema,
  outputSchema,
  activities: ["policy_loading", "content_processing"],
  execute: async (input, context) => {
    const policy = await context.runActivity("policy_loading", () => loadPolicy());
    return context.runActivity("content_processing", () => process(input, policy));
  },
});
```

活动名必须是最多 64 个字符的小写 snake case，列表最多 32 项且不能重复。名称必须由代码固定，不能拼接 input、资产标识、URL、供应商响应或其他运行时内容。`runActivity` 自动记录 start/finish、`succeeded|failed|cancelled` 和耗时；Attempt finish 记录 `succeeded|failed|timed_out|cancelled` 与可选公开错误码。异步 Worker 传入持久化 Attempt number，同步执行固定为 1。

按 `runId` 筛选日志，再按 `attemptNumber` 和 `sequence` 排序即可还原执行时间线。`sequence` 只在单个 Attempt 内递增；跨 Attempt、实例或 Process Run 不承诺全局顺序。Pino 添加数值 `level`、`pid`、`hostname`、`service`、`module` 和 `msg`；事件自己的 ISO `timestamp` 是唯一时间字段。started 与成功 finish 使用 `info`，失败或取消使用 `warn`，以 `INTERNAL_ERROR` 结束的失败 Attempt 使用 `error`。

`PROCESS_RUN_LOG_LEVEL` 控制 Pino 阈值，默认 `info`，可设为 `fatal|error|warn|info|debug|trace|silent`。设为 `warn` 时只输出失败、取消和超时；设为 `silent` 时关闭 Process Run 活动日志。日志 sink、Pino destination 或时钟失败不会改变 Process Result。日志不保存 accepted input、output、Prompt、Tool 参数、模型消息、隐藏推理、Secret、远端正文或内部异常消息。Pino redaction 是敏感字段名的兜底保护，不能替代 `ProcessRunLogRecord` 的源头白名单。

运行活动日志是 best-effort 观测，不是权威 Process Event、状态库、Run Record 或产品查询 Interface。需要可靠状态与结果时，异步调用方仍查询 owner-scoped `GET /process-runs/{runId}`；需要业务审计时，应设计独立的授权、持久化和保留策略。

## 接入 Run Record

默认生产构造使用 disabled 实现，只输出结构化 Attempt 与活动日志。开发或单实例测试可以注入有容量上限的内存实现：

```ts
import { createProcessingApplication } from "./src/api/application.js";
import { createProcessExecutor } from "./src/processes/catalog.js";
import { createInMemoryProcessRunRecords } from "./src/process-runtime/records.js";

const runRecords = createInMemoryProcessRunRecords({ maxRecords: 100 });
const executor = createProcessExecutor({
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

部署预检必须在 `npm run build` 后、每个角色自己的环境变量和 Secret 已注入时运行：

```bash
npm run check:deployment-env -- api
```

可选角色为 `api`、`crt-business-api`、`process-dispatcher`、`process-worker`、`webhook-worker`、`retention-cleaner`、`async-operations` 和 `process-recovery`。命令检查该角色无默认值的必填项，空字符串和纯空白都视为缺失；Agent 角色和 CRT Business API 还检查各自供应商凭证名称。命令不会连接 PostgreSQL、Redis、模型、OSS 或 Business Capability，也不会输出配置值。每个 Construction Root 会在创建 Adapter 前重复基础检查，再由原有解析器校验 URL、数值、枚举和跨字段约束。

- 新增配置时同时更新 `.env.example`、启动构造测试和相关文档。
- 只把稳定运行策略放入环境配置。Process 拓扑、Schema 和业务语义留在代码中。
- 成组配置在启动时一起校验。例如 `PI_PROVIDER` 与 `PI_MODEL` 必须同时设置。
- 异步功能关闭时忽略数据库和网关专用配置；启用后缺少任一必需值都在监听前失败。
- `CONTENT_PROCESSING_MODE=direct` 只关闭文本 Agent；`minimal-zine-poster/v1` 与 `crt-interface-image/v1` 始终使用 Agent，因此共享的 Pi provider、model 和 API mode 仍须有效。
- `POSTER_API_TIMEOUT_MS` 只控制受控 `POST /posters` Adapter，默认 `90000`；Process 总超时仍由 `PROCESS_TIMEOUT_MS` 治理。
- `CRT_API_TIMEOUT_MS` 只控制受控 `POST /crt-images` Adapter，默认 `180000`。受控发布必须让 `PROCESS_TIMEOUT_MS` 长于它，平台请求超时再长于 Process 总超时。
- `IMAGE_PROVIDER=openai|fal` 选择真实图片集成 Adapter，默认 `openai`。OpenAI Adapter 可用 `OPENAI_IMAGE_API_KEY` 与 `OPENAI_IMAGE_BASE_URL` 脱离 Agent 网关；未设置时回退到 `OPENAI_API_KEY` 与 `OPENAI_BASE_URL`。FAL Adapter 只读取服务端 `FAL_KEY`，并固定调用 GPT Image 2 生成与编辑 endpoint。
- `INTERNAL_EVAL_ENABLED=true` 挂载 `POST /internal/eval/execute`。该入口仅接受三个新闻图片 Process，复用正式 Executor、Registration、Agent 和图片 Capability，在同一次成功执行中返回实际 Prompt、文本模型与非敏感图片参数。响应使用 `no-store`，诊断内容不进入正式输出、日志或 Run Record；生产 Compose 当前开启，鉴权与 `/execute` 一并后续统一处理。
- `CRT_IMAGE_EVIDENCE_MODE=off|metadata|full` 控制 `crt-interface-image/v1` 的服务端证据副本。产品请求不能覆盖它；本地完整验收默认 `full`，生产 `POST /crt-images` 必须默认 `off`。
- `CRT_IMAGE_EVIDENCE_DIRECTORY` 只在 `metadata` 或 `full` 时使用。完整字段、敏感数据边界和清理责任见 [`crt-interface-image` 的证据保留说明](processes/common/crt-interface-image/evidence-retention.md)。
- `PI_SKILL_DIRECTORY`、`PI_POSTER_SKILL_DIRECTORY` 与 `PI_CRT_SKILL_DIRECTORY` 分别覆盖一个固定绑定，不改变 Skill 名称、集合或顺序。
- `.env.example` 把 `PROCESS_TIMEOUT_MS` 设为 `240000`，用于同时容纳 CRT edit 和 finalizer 的受控发布形状；未设置变量时，代码默认值仍为 `30000`。
- Secret 只由本地 `.env` 或部署平台注入。日志和错误响应不得包含凭证、Base URL、远端正文或模型错误。

## 测试策略

按风险从窄到宽验证：

1. 在改动附近运行单个测试文件，例如 `npm test -- test/process-runtime.test.ts`。
2. 运行 `npm run check`、`npm run typecheck` 和 `npm test`。
3. 修改构建、入口或发布资源时运行 `npm run build`；修改镜像时再构建 Docker image。
4. 只有确定性验证通过后，才运行需要凭证、网络或费用的 smoke。

测试职责保持清晰：

- Startup Construction 测试配置解析、跨字段拒绝和完整生产组装。
- Process Runtime 测试 Registration、Registry、Process Attempt Runner 和同步 Runner 的 Interface invariant。
- HTTP Adapter 测试传输错误、容量、状态码和请求级结构化日志；Process Attempt Runner 测试运行活动日志。
- Application 测试 server 生命周期，不了解具体 Business Process。
- Process Registration 测试流程 Schema、获准依赖、策略和错误契约。
- Adapter 测试协议与错误转换；默认使用本地受控依赖。

修复缺陷时先增加能跨正确 Seam 复现问题的测试。若只能穿透 Interface 才能验证，先重新检查 Module 形状。

## 完成标准

一项开发改动完成时应满足：

- Interface 比改动前更清楚，或至少没有把 Implementation 知识推给调用方；
- 预期失败有稳定错误码，意外失败不会泄露内部消息；
- 确定性测试覆盖成功、拒绝和关键 invariant；
- `npm run check`、`npm run typecheck`、`npm test` 和受影响的构建检查通过；
- 配置样例、项目说明、设计文档和 Runbook 与代码保持一致；
- 不含 `.env`、真实业务内容、签名 URL、模型过程或其他敏感产物。
