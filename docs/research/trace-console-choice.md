# Pipipi 执行控制台的自研边界

给需要调试表情包开发和线上执行的团队。2026-11-13 的建议是继续维护流程与 Skill 目录、按业务 `runId` 查看结果的入口，以及产生业务事件的代码。通用 trace 搜索、调用树和瀑布图可以复用现成页面。先与已有控制台并行对照一条执行，再决定是否替换其详情视图。[现有控制台与同步、异步验证](character-emoji-harness-choice.md)

## 表情包执行在现成页面里能看到什么

首选对照 **Arize Phoenix**（12,269 ★）。在本机隔离环境，用已有 Phoenix 14.8.0 镜像启动单容器与 SQLite。将一条已完成的 `character-emoji/v4` 表情包样例的脱敏活动通过 OTLP 导入，用业务 `runId` 去除连字符作为本次 32 位十六进制 trace ID。浏览器打开该次运行，能看到父级 Process 及其下的构思、渲染两个步骤。展开构思能看到实际绑定的两份 Skill、模型、`search_memes`、HTTP 503、改用原创及第二轮校验通过。原记录没有精确的轮次起止时间，页面以属性展示这两轮结果。[本机 Phoenix 对照样本](http://127.0.0.1:52715/projects/UHJvamVjdDoy/spans/dd96ec8bffc74d18909c1b6c8c81f097?selectedSpanNodeId=U3Bhbjoy) · [原始运行与固定响应条件](character-emoji-harness-choice.md)

这个实验验证了现成 UI 能解释一次业务执行。数据来自使用固定上游响应的已有运行，没有再次调用供应商。正常入口实时上报、跨 Worker 自动传播与云端持久化仍待端到端验证。Phoenix 提供 SQLite 和 PostgreSQL 自托管选项，内部自用免软件订阅，许可证为 Elastic License 2.0（ELv2），对托管转售等用途有限制。要求 Apache 许可证或优先通用跨服务查询时，改选 Jaeger。[Phoenix 自托管](https://arize.com/docs/phoenix/self-hosting/deploying-phoenix) · [许可证](https://github.com/Arize-ai/phoenix/blob/main/LICENSE)

## 其他部署选择

| 选择 | 开发时能看到什么，线上怎么查 | 成本与适用条件 |
| --- | --- | --- |
| **Jaeger** · 23,407 ★ | 同一个 Web UI 展开服务、耗时、父子调用和事件。Pipipi 上报 `pipipi.run_id` 属性供搜索，或从业务详情直达对应 trace。本机可用单进程和内存存储。 | Apache-2.0，可在国内机房自托管。云端要在重启后查历史，单机小流量可配置 Badger 和持久卷，规模扩大再考虑 OpenSearch。[项目](https://github.com/jaegertracing/jaeger) · [入门](https://www.jaegertracing.io/docs/2.23/getting-started/) · [存储](https://www.jaegertracing.io/docs/2.23/storage/) |
| **阿里云可观测链路 OpenTelemetry 版** | 同一套业务 spans 在本机进 Jaeger，云端改到国内地域的接收地址。在「调用链分析」按自定义属性过滤 `pipipi.run_id`，点开整条链路。 | 适合想省去云端 trace 数据库运维的团队。新版按写入量计费，账号内共享链路 25 GB/月、指标另 25 GB/月。链路保留 30 天，普通中国内地地域超额 0.4 元/GB，额外归档另收。每天每应用每种有用量的数据最低按 0.1 GB 计。本次未开通云服务。[国内地域](https://help.aliyun.com/zh/arms/tracing-analysis/product-overview/supported-regions) · [按属性搜索](https://help.aliyun.com/zh/opentelemetry/developer-reference/use-trace-explorer-to-query-traces) · [计费](https://help.aliyun.com/zh/opentelemetry/product-overview/billing-description) |
| **Langfuse OSS + Pi 社区插件** · 主仓 37,392 ★ | 现成的模型轮次、工具、用量等视图。嵌入式 Pi 插件支持用宿主 session ID 关联多个 trace，且会通过 `onTraceId` 返回根 trace ID。也可自行用 Langfuse SDK 从外部 ID 确定生成 trace ID。两种接法需选定并验证。 | 基础追踪自托管免许可证费，可在国内部署。官方 Compose 包含 Web、Worker、PostgreSQL、ClickHouse、Redis、对象存储等。插件默认采正文，生产要显式 `captureContent: false`，另行筛选业务 metadata。适合重度使用模型观测、评测的团队。[嵌入 Pi 的例子](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-langfuse/README.md#-host-application-embedding) · [外部 ID 关联](https://langfuse.com/docs/observability/features/trace-ids-and-distributed-tracing) · [免费版边界](https://langfuse.com/self-hosting/license-key) · [部署配置](https://github.com/langfuse/langfuse/blob/main/docker-compose.yml) |
| **扣子罗盘 Coze Loop 开源版** · 5,799 ★ | 中文控制台支持 SDK trace 上报和查看。在 Node.js 里可用 SDK 上报自定义 span 和标签，并指向自托管地址。接入时将业务 ID 与 trace 关联，须在选定版本实测检索体验。 | Apache-2.0，适合中文团队同时做 Prompt 调试及评测。官方 Compose 涉及 MySQL、Redis、ClickHouse、MinIO、RocketMQ 等，仅需查 trace 时运维量偏大。[中文项目说明](https://github.com/coze-dev/coze-loop/blob/main/README.cn.md) · [开源版 SDK 配置](https://github.com/coze-dev/coze-loop/wiki/8.-Open-source-edition-uses-CozeLoop-SDK) · [部署配置](https://github.com/coze-dev/coze-loop/blob/main/release/deployment/docker-compose/docker-compose.yml) |

扣子托管版自 2026-07-01 起对新增 Trace 日志按量和保留时长计费，自托管开源版由团队承担基础设施成本。[扣子托管版 Trace 计费](https://docs.coze.cn/coze_pro_trace_fee)

星数取自当日 GitHub 主仓。Pi 插件的维护者与 Langfuse 独立。Pi v1.4.0 也提供官方 `TelemetryContext` 和跨进程传播合同，具体 exporter 由宿主提供。官方 p2 展示自己实例的遥测，社区 Pi 会话工作台读取会话文件或扩展事件。Pipipi 的内存会话、异步 Attempt 和会话外的图片调用均需显式关联。[Pi 官方遥测](https://github.com/earendil-works/pi/blob/v1.4.0/packages/telemetry/README.md) · [Pi 工具与数据源对照](character-emoji-harness-choice.md)

## 什么仍由 Pipipi 提供

显示「本次允许搜梗」「工具已返回」「搜索服务报 503，因此改用原创」需要三条不同事实。只有 Pipipi 知道业务为何兜底，以及某次请求批准的 Skill 精确版本。Agent 调用树也无法列出过去从未跑过的 Registration。保留 production catalog、Run/Attempt、业务决定和生图回执的权威来源，外部查看器只接收允许展示的投影。生产只上报脱敏状态、耗时和规则码，开发时保留现有本机可见正文边界。[表情包 503 示例](character-emoji-harness-choice.md) · [项目业务与观测边界](../../CONTEXT.md)

可以用现成的 **bull-board**（3,530 ★，MIT）以只读模式接已有 BullMQ 查询排队、失败和任务详情。当前队列只负责唤醒 Worker，业务输入、历史结果和安全重试由其他模块拥有。动态增减 Worker 副本仍需部署系统按积压控制。需要统一派发、Worker 与流程定义页面时，再比较 Hatchet 带来的调度迁移成本。[bull-board](https://github.com/felixmosh/bull-board) · [Pipipi 队列与扩容实测](cloud-worker-control-plane.md)

## 采用前的验收

用正常业务入口执行同一组固定响应的表情包样本。开发端在执行过程中能看到已完成的步骤，能区分搜梗失败、改用原创和业务整体成功。云端只拿提交接口给出的 `runId`，由另一进程查到 API、排队和 Worker 执行，重启查看器后仍能查看，而且重试归在同一业务 Run 的不同 Attempt。检索保留覆盖约定时窗内的运行，避免采样造成「有 runId 却没有 trace」。如继续采样，业务记录应标明该次没有详细 trace。[现有跨 Worker 验收](https://github.com/hkai-ai/pipipi/blob/fc5662d/test/pi-trace-async.integration.test.js) · [OpenTelemetry 跨进程传播](https://opentelemetry.io/docs/concepts/context-propagation/)
