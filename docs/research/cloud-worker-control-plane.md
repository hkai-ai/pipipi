# Pipipi 云端 Worker 扩容与统一管理

截至 2026-11-13，建议继续使用 PostgreSQL、Dispatcher 和 BullMQ。现有 Worker 增加执行槽位就能提高异步表情包任务的吞吐，同一队列也支持多个 Worker 进程。现阶段无需为提高并发而引入 Hatchet。

## 异步表情包并发实测

在提交 `85ae9db` 的隔离实例上，通过 `POST /process-runs` 提交 `character-emoji/v4` 单图请求。API 持久化 Run 和 outbox，Dispatcher 将任务发布到 BullMQ，Worker 领取后运行真实 Pi 会话。测试要求搜梗，两次模型响应各延迟 75 ms，搜索响应延迟 50 ms，生图响应延迟 300 ms，参考图 HEAD 在本地返回。环境为 Apple M4 Max、Node 24.15、独立 PostgreSQL 17 和 Redis 7.4。Dispatcher 沿用默认间隔 1 秒、每批最多 25 条。[Worker 配置](../../src/app/process-worker.ts) · [Dispatcher 配置](../../src/app/process-dispatcher.ts)

每种配置单独预热，然后分别同时提交 1、4、24 个请求，每批清空后再提交下一批。下表取相同负载的两批 24 请求，每行 48 个样本。吞吐按完成数除以各批从开始提交到全部写入终态的总耗时计算。排队从 Run 创建算到 Worker 开始执行，包含 outbox 派发等待。端到端从发起 POST 算到数据库写入终态。

| Worker 进程 × 每进程槽位 | 实际同时执行峰值 | 吞吐（Run/秒） | 排队 p95（秒） | 端到端 p95（秒） |
| --- | ---: | ---: | ---: | ---: |
| 1 × 1 | 1 | 1.71 | 12.95 | 13.51 |
| 1 × 2 | 2 | 3.28 | 6.52 | 7.06 |
| 1 × 4 | 4 | 6.24 | 3.45 | 3.97 |
| 2 × 2 | 4 | 6.19 | 3.47 | 4.02 |

两个 Worker 在 24 请求档各完成 24 个 Run。所有档位合计 252 个计量 Run 和 4 个预热 Run，均成功，每个 runId 各有一次执行尝试和一次模拟生图。每批抽查一个 runId，通过 GET 核对交付结果，再用原幂等键重放 POST，均返回原 runId。

这组吞吐对应固定的 500 ms 上游等待。生产容量仍取决于实际模型和图片延迟、供应商限流、内存及其他 Process 对槽位的占用。当天可读数据库近七天有 31 条归档执行记录，其中 v4 为 0，异步 Run 表也没有同期记录。该连接是否覆盖生产异步流量、线上 Worker 的实际并发配置均待核实。

扩容时先在生产异步队列对照高峰到达率、排队 p95、最老任务等待时间和上游 429。若排队超目标、槽位持续占满且上游有余量，优先逐级提高 `PROCESS_WORKER_CONCURRENCY`。若单进程资源吃紧或需要进程隔离，再增加 Worker 副本。等到需要按任务类别分配容量、按积压自动扩缩多机 Worker，或统一暂停和查看多个队列时，再评估 Hatchet。

## 两种部署选择

| 部署方式 | 谁增加 Worker 容量 | 云端控制台能看什么 | Pipipi 需要接什么 |
| --- | --- | --- | --- |
| Trigger.dev Cloud | 平台托管计算资源并自动扩容，实际并发受环境配额和任务队列限制 | 按环境和版本查任务，打开单次运行看时间线、日志、输出与错误，可取消或重放 | 用 TypeScript task 调既有执行器，把业务 runId 传入。需要展示的 Pi 事件另外接入。 [部署差异](https://trigger.dev/docs/self-hosting/overview) · [控制台与 SDK](https://trigger.dev/product) |
| Trigger.dev 自托管 | 自己增减 Worker 节点，控制面和 Worker 可以独立部署。官方对照表明确标注节点扩容为手动，要求按积压自动增减时须另配基础设施 | 自托管 Web 应用提供管理页面。依赖包括 PostgreSQL、Redis，Worker 运行任务容器 | 运行控制面、构建与部署任务，并承担 Worker 节点容量管理。 [官方架构与功能表](https://trigger.dev/docs/self-hosting/overview) |
| Hatchet + 自有 Kubernetes | 可自托管 Hatchet 或使用 Hatchet Cloud 控制面。Worker 在自己的云里，官方示例用 KEDA 轮询 Task Stats 的队列积压，自动增减指定 Deployment 的 Pod | Workflows 看已注册定义，Workers 看已连接实例及健康状况，Runs 看状态、输入输出和历史。可暂停派发 | TypeScript Worker 注册任务，配置 KEDA 的目标队列、最小和最大副本及认证。节点池弹性另由云集群提供。 [部署架构](https://hatchet.run/) · [KEDA 配置](https://docs.hatchet.run/v1/autoscaling-workers) · [管理页面](https://docs.hatchet.run/v1/developer-experience) · [暂停派发](https://hatchet.run/announcement/workflow-pause-and-viewer-roles) · [TypeScript SDK](https://docs.hatchet.run/reference/typescript) |

GitHub 主项目规模为 Trigger.dev 16,757 stars（Apache-2.0），Hatchet 8,273 stars（MIT）。自托管需要承担云资源开销，托管平台另有用量限制和计价。[Trigger.dev 仓库](https://github.com/triggerdotdev/trigger.dev) · [Hatchet 仓库](https://github.com/hatchet-dev/hatchet) · [Trigger.dev 定价](https://trigger.dev/pricing) · [Hatchet 定价](https://hatchet.run/pricing)

## Pi 的现成接入示例

Trigger.dev 团队公开了一个只用普通 task 和 session 承载 Pi、Claude Code、Codex 的示例。Pi 执行自己的 Agent 循环；示例应用把文本与工具事件传到前端，保存原生会话，让新 Worker 恢复同一会话。这个仓库核验时为 1 star，作者将其定位为 PoC。它能作为接入参考，生产能力的依据仍是平台文档。把 Pipipi 的 Process 包成单个 task 后，平台只掌握该 task 及发送给它的事件；要按业务 runId 看到选中的 Skill、搜梗结果状态或生图回执，需要 Pipipi 发送已有记录中的安全字段。[Trigger.dev 官方组织的 Pi 示例](https://github.com/triggerdotdev/multi-harness-poc) · [单次运行观测](https://trigger.dev/product/observability-and-monitoring)

## 直接管理 Pi 会话的云平台

Rivet（主仓 6,898 stars，Apache-2.0）维护 `@rivet-dev/pi`，让每个 Pi 会话作为一个可休眠的 Actor 运行，单个节点可以承载多个会话。Pi 的事件可流到客户端；Inspector 可查 Actor 状态、日志及连接，也支持注册业务调试页。Rivet 提供托管计算，也提供自托管控制面与 Kubernetes 节点方案；官方 Kubernetes 示例按 CPU 使用 HPA 增减节点。对大量时间花在等待模型或图片网关的任务，应另外验证 CPU 能否反映容量，不能将 Actor 唤醒次数当作 Worker 节点副本数。Pi 集成会保存会话历史，接入前应核对是否符合现行业务材料保留边界。[Pi Actor 集成](https://rivet.dev/changelog/2026-10-01-introducing-pi-1-0-for-rivet/) · [托管计算](https://rivet.dev/changelog/2026-06-17-introducing-rivet-compute/) · [Kubernetes 扩缩节点](https://rivet.dev/actors/self-host/workers/kubernetes/) · [Inspector](https://rivet.dev/changelog/2025-1-12-rivet-inspector/) · [代码和许可证](https://github.com/rivet-dev/rivet)

另一条有官方实现的路径是 Cloudflare Agents SDK 的 PiHarness，在 Durable Object 中执行 Pi Durable，并以 WebSocket 把会话流到浏览器。适合让平台按会话分配执行资源；文档的示例 UI 用于会话操作，若要集中枚举 Pipipi 注册版本、查看任务积压和关联业务 runId，需另外装配。[PiHarness 官方文档和示例](https://developers.cloudflare.com/agents/harnesses/pi/)

## 当前服务扩容需要验证的条件

Pipipi 的异步入口已有 PostgreSQL、Dispatcher 和 BullMQ Process Worker；同步请求在 API 内执行。现行单机 Compose 为 Worker 指定了固定容器名、host 网络及健康端口，Worker 通过本机回环访问内部图片服务。跨机部署应提供可达、受控的内部服务地址，并保持原图和回执的恢复语义。保留现有队列时，可用 Kubernetes Deployment + KEDA 从队列积压指标扩缩 Worker，继续通过 Pipipi 控制台查业务轨迹。该组合由 Kubernetes 管副本数，已有控制台管业务运行，云机器扩缩还依赖节点池配置。[现有生产 Compose](../../compose.production.async.yaml) · [队列实现](../../src/process-runs/queue/bullmq.ts) · [KEDA 指标扩缩](https://keda.sh/docs/2.21/scalers/prometheus/)

若需要同一云产品统一展示任务定义、运行及排队情况，优先选一条异步表情包请求验证 Hatchet 或 Trigger.dev。让新平台独立拥有该测试队列的派发和重试，保留 runId 与图片幂等回执。用固定模型、搜索和图片响应制造积压，观察实际 Worker/任务容量、清空后的缩容、缩容时进行中的任务，以及同一 runId 的图片派发次数。平台的能力矩阵来自一手文档，本次没有部署或实测弹性。Trigger.dev 组织示例锁定的 Pi SDK 为 0.85.1，本仓为 1.4.0。[示例依赖](https://github.com/triggerdotdev/multi-harness-poc/blob/main/package.json)
