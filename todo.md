# 后续开发清单

本文件记录尚未实现的计划，不代表当前系统已经具备这些能力。

## P1：运维控制台的后续项

控制台已经落地：Run Record 与活动时间线持久化到 PostgreSQL（本地开发用 JSONL），
Process 目录由 Registration Schema 推导，聚合统计与 Preact 单页界面均已交付。
以下是明确没有做、且已知需要跟进的部分。

### 访问控制（上线前必须处理）

- [ ] 在 OpenResty 为 `CONSOLE_BASE_PATH` 加 Basic Auth 或 `auth_request`。控制台没有应用内鉴权，页面上的提交表单会真实调用 `POST /execute` 并产生图片费用，Process 目录还会暴露内部 Schema。
- [ ] 把 `CONSOLE_BASE_PATH` 从默认 `/console` 改成不可猜路径。这只是缓解手段，不能替代上一条。
- [ ] 收紧数据库 `pg_hba.conf`：当前唯一允许远程连接的规则是 `host all postgres 0.0.0.0/0`，超级用户对全网开放且允许非 TLS 连接。专用账户 `pipipi_app` 已建好但没有 HBA 规则。生产部署现会 live audit TLS、superuser 和 `SET ROLE`，因此必须先允许 `pipipi_app` 直接登录并删除 `options=-c role=`，旧 workaround 已不能通过发布门禁。

### 数据与运维

- [ ] 让真实 PostgreSQL 备份作业发布 `$REMOTE_PATH/shared/postgres-backup/evidence.json`，完成一次可恢复性演练，并对活动 revision 运行受保护的 `Console production readiness`；手写证据不算完成。
- [ ] 把 `PROCESS_RUN_RECORD_RETENTION_DAYS` 与对象存储生命周期规则对齐。控制台已经把加载失败的图片标为"对象已过期"，但保留期不匹配仍会让历史里出现大量死链。
- [ ] 保留期清理目前只在启动时执行一次。长期运行的实例需要按日触发，或交给外部定时任务。
- [ ] 数据库证书 2035 年到期，且 SAN 里没有 IP。若重签出带 `IP` SAN 的证书，可把连接串从 `verify-ca` 改回 `verify-full`。

### 控制台功能

- [ ] 失败记录关联到对应的 Pino 活动日志检索入口。
- [ ] 从记录一键重跑。记录已含完整输入，技术上可行，但会真实计费，等鉴权到位再加。
- [ ] 同输入不同参数的并排对比（CRT 保留 `rawImage` 正是为此）。
- [ ] 筛选结果导出 CSV/JSON。
- [ ] 费用视图。按 Process 的执行计数已经有了，缺的是单价配置与汇总。

### 已知限制

- 归档只保存终态执行。进程执行中途被杀不会留下终态记录，只有活动日志里的开始事件。
- Run Record 与活动记录是两条独立的尽力而为写入，`/execute` 返回后记录可能先于最后一条活动落盘。
- 同一 `runId` 重复出现时，记录以最新一条为准。
- 统计的耗时只取 Attempt 级完成事件；Registration 内部的重试（如 CRT 的 Agent 编译）不计为 Attempt，因此不出现在分位数里。
- 控制台不做按调用方隔离：任何能访问它的人都能看到全部记录。

## P0：Execution Telemetry 与 Trace

### 已确认的决策

- [ ] 把 Trace 作为生产可观测性的必备能力，覆盖 Business Process、Agent、模型调用、Tool、Business Capability、输出校验和持久化阶段。
- [ ] 新建 `Execution Telemetry Module`。它是运行时横切 Module，不是 Business Capability、Runtime Skill、Tool 或产品请求字段。
- [ ] 保留 `runId` 作为持久业务关联键；`traceId` 只用于诊断，不能替代 `runId`。
- [ ] 保留 Run Store 作为运行状态和审计事实来源。Trace 是尽力而为的诊断数据，不能驱动业务状态或重试决策。
- [ ] 继续设置 `noExtensions: true`，禁止生产环境发现或加载任意第三方 Pi Extension。
- [ ] 暂不把 Braintrust、Langfuse、`pi-trace-extension` 或其他社区 Telemetry Extension 直接装入生产运行时。
- [ ] 允许通过标准 OTLP Adapter 把脱敏 Trace 导出到 Braintrust 或其他 OpenTelemetry 后端；后端选择不侵入领域层。

### 目标 Trace 结构

```text
business_process.run [runId]
├─ process.accept
├─ process.attempt [attempt]
│  ├─ agent.run
│  │  └─ agent.turn
│  │     ├─ llm.request
│  │     ├─ tool.execute
│  │     │  └─ capability.content_process
│  │     └─ llm.request
│  └─ output.validate
└─ run_record.write
```

异步执行不维持一个跨队列、跨进程的长生命周期 Span。提交、Outbox、Worker Attempt 和 Webhook Delivery 分别创建 Trace，并通过 `runId`、`eventId`、`deliveryId` 和 Span Link 关联。一个 `runId` 可以对应多次 Attempt Trace。

### Module 与 Adapter

- [ ] 定义应用自有、封闭且类型化的 `process.*` Telemetry schema。
- [ ] 评估并把 `@earendil-works/pi-telemetry` 声明为直接依赖，版本与当前 Pi 依赖对齐；复用其 `TelemetryContext`，避免建立第二套上下文协议。
- [ ] 提供 No-op Adapter，确保未配置 Telemetry 时不改变现有行为。
- [ ] 提供 In-memory Adapter，用于确定性测试 Span 层级、字段和上下文隔离。
- [ ] 提供 OpenTelemetry/OTLP Adapter，用于生产导出。
- [ ] 由各 Construction Root 创建并注入 Telemetry Context；领域对象和产品请求不读取导出器配置。
- [ ] 为 Pi Agent 实现应用自有的可信事件桥接器，把 Agent、Turn、LLM 和 Tool 生命周期翻译为子 Span。桥接器只接收允许字段，不保存 Pi 原始事件载荷。
- [ ] 在 Adapter 边界评估映射 OpenTelemetry GenAI semantic conventions；核心接口仍使用应用自有 schema。

### 数据边界

默认只记录元数据，禁止通过“调试方便”绕过以下边界。

| 默认允许 | 默认禁止 |
| --- | --- |
| `runId`、Process ID/版本、执行模式、Attempt 序号 | 业务输入和业务输出 |
| Skill 名称、revision、digest | system prompt、用户 prompt、模型回复 |
| provider、model、API mode、Turn 序号、Tool/Capability 名称 | Tool 参数、Tool 结果、Pi 原始事件载荷 |
| 状态、耗时、TTFT、token/cache/cost 汇总、stop reason | header、凭证、端点 URL、幂等键 |
| retry、timeout、cancel、标准化错误类型和错误码 | 远端原始响应、可能携带内容的原始错误消息 |
| 输出校验结果、`eventId`、`deliveryId` | hidden reasoning、chain of thought、thinking signature |

- [ ] 为每个字段定义分类、基数、保留期和脱敏规则。
- [ ] `runId`、`eventId`、`deliveryId` 只能用于 Span、日志关联或检索，不能成为 Metric label。
- [ ] 需要解释“为什么”时，增加显式、枚举化的 decision/reason event；不采集隐藏推理。
- [ ] 初期在受控环境全量采集元数据 Trace，始终关闭 Payload 采集；压测后再确定生产采样和保留策略。

### 分阶段实现

#### 1. 设计与契约

- [ ] 在 `docs/process-runtime-design.md` 补充 Module、Interface、Implementation、Seam 和 Adapter 设计。
- [ ] 如设计形成长期约束，在 `docs/decisions/` 新增决策记录。
- [ ] 固定 Span 命名、父子关系、状态映射、字段白名单、采样、保留期和导出失败语义。
- [ ] 明确直接执行、Agent 执行、同步执行和异步执行的上下文传播规则。

#### 2. 核心运行时

- [ ] 实现 No-op、In-memory Adapter 和 Execution Telemetry Context。
- [ ] 为 Process Run、Accept、Attempt、Output Validation 和 Run Record 写入增加 Span。
- [ ] 在公开错误被标准化之前记录安全的错误类型、错误码和失败阶段。
- [ ] 让 Telemetry 初始化、记录和导出失败保持非阻塞；失败不得改变 Process 结果、重试、取消或持久化状态。

#### 3. Agent 事件桥接

- [ ] 用应用自有 inline event bridge 记录 Agent Run、Turn、LLM Request 和 Tool Execute。
- [ ] 把受限 Tool 对 Business Capability 的调用记录为 Tool Span 的子 Span。
- [ ] 记录模型耗时、TTFT、token/cache/cost 汇总和 stop reason，不记录请求或响应正文。
- [ ] 验证 `noExtensions: true` 仍会阻止外部 Extension 的发现和加载。
- [ ] 后续 Pi Agent API 若提供完整的 Context 传播，再评估用原生传播替换事件桥接器。

#### 4. 异步关联

- [ ] 为 Submission、Outbox Publish、Worker Attempt 和 Webhook Delivery 建立独立 Trace 或 Span Link。
- [ ] 日志同时输出 `traceId`、`runId`、`eventId` 和 `deliveryId` 中适用的关联字段。
- [ ] 不向产品请求、Process Definition 或 Queue Job body 暴露 Telemetry 配置。

#### 5. OTLP 与运维

- [ ] 实现有界队列、批量导出和有界 shutdown flush，防止导出器拖慢或耗尽服务资源。
- [ ] 用节流日志和内部计数暴露丢弃、导出失败和队列饱和；Telemetry 后端故障不应使业务服务失去就绪状态。
- [ ] 在 Construction Root 中配置 endpoint、认证、采样和资源属性，确保凭证不进入 Span。
- [ ] 选择后端：允许 SaaS 时优先评估 Braintrust 的 OTLP 接入；有数据驻留要求时使用受控 OpenTelemetry 后端。
- [ ] 建立按 `runId` 检索的排障视图，以及延迟、错误率、token/cost、重试和导出健康度看板。

#### 6. 文档与验证

- [ ] 更新 `README.md`、`CONTEXT.md`、受影响的设计文档、开发文档、环境变量示例和运维手册。
- [ ] 增加单元测试、集成测试和并发上下文隔离测试。
- [ ] 运行 `npm run typecheck`、`npm test` 和 `npm run build`。
- [ ] 把需要网络、凭证或费用的 OTLP smoke test 独立列出，并在取得明确授权后执行。

### 验收标准

- [ ] 操作者可用 `runId` 找到同一次执行的全部已采集 Trace，并区分每次 Attempt。
- [ ] Direct 与 Agent 两条执行路径都显示关键阶段、耗时和结果。
- [ ] Agent Trace 显示 LLM、Tool 和 Capability Span，但不含业务正文、Prompt、Tool 载荷或隐藏推理。
- [ ] 模型、Tool、Capability 或输出校验失败时，恰有一个对应失败 Span，并记录标准化失败阶段和错误码。
- [ ] Telemetry Adapter 抛错、超时、队列满或后端不可用时，Process 的响应、状态、重试和持久化结果保持不变。
- [ ] 并发运行之间没有错误的父子 Span 关系或上下文泄漏。
- [ ] 自动化测试证明所有默认禁止字段不会进入 Span、日志或 Metric label。
- [ ] 生产运行时没有加载第三方 Pi Extension。

### 明确不做

- 不把第三方 Telemetry Extension 直接加载到生产 Pi Agent。
- 不记录原始业务内容、Prompt、Tool 载荷或 chain of thought。
- 不把 Telemetry 变成产品请求、Process Definition、Runtime Skill 或运行状态的一部分。
- 不用 Trace 替代 Run Store、结构化日志或业务审计记录。

### 参考材料

- [Pi Telemetry package](https://github.com/earendil-works/pi/tree/main/packages/telemetry)
- [Braintrust OpenTelemetry integration](https://www.braintrust.dev/docs/integrations/sdk-integrations/opentelemetry)
- [OpenTelemetry GenAI agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)
