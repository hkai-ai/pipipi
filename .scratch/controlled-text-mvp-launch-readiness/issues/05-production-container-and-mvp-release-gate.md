# 05 — 交付生产容器与 MVP 发布门禁

**What to build:** 产出一个可重复构建、以非 root 身份运行的 Node.js 24 Linux 服务镜像，并给出受控文本 MVP 的可执行发布门禁。平台维护者能够用同一产物配置私有入口、秘密信息、并发和超时，验证真实 Business Capability 与可选 Agent 链路，并在异常时按说明回滚。

**Blocked by:** 04 — 增加脱敏结构化运行日志.

**Status:** resolved

- [x] 多阶段容器构建使用 Node.js 24；构建阶段按锁文件安装依赖并编译，运行阶段只携带生产依赖、编译产物和已审核的内容优化 Skill。
- [x] 运行进程使用非 root 用户，监听平台提供的端口和容器网络接口，并保留现有优雅关闭行为。
- [x] 构建上下文排除本地依赖、编译产物、环境文件、凭证、实验产物、报告、版本库元数据和 scratch tracker 内容；镜像不包含任何 API 密钥、本地 Pi 认证目录或云服务凭证。
- [x] 从构建完成的镜像启动服务后，容器健康检查通过；验证运行身份和 Skill 包装时不调用真实模型或消耗供应商额度。
- [x] 发布说明列出必需配置、秘密信息注入、镜像构建与启动、健康探测、回滚和真实集成冒烟步骤，并要求 `BUSINESS_API_BASE_URL` 指向生产环境可达的 Business Capability，而不是本地主机演示服务。
- [x] 发布门禁要求 TLS、调用方认证和私有入口由部署平台或可信网关实施，并验证容器端口不能绕过入口被公网直接访问；应用本身不新增用户系统、RBAC 或 CORS。
- [x] 文档给出受控 MVP 初始档位：每实例并发 2–4、最大实例数 2–5、Business Capability 超时 10 秒、Process Run 超时 120 秒、平台请求超时 150–180 秒，并说明提升容量前需要观察内存、延迟、下游容量、模型配额和成本。
- [x] 发布候选必须通过类型检查、确定性测试、生产构建、镜像启动和健康探测；默认验证不访问真实模型、云凭证或 OSS。
- [x] 启用 Agent 模式时，显式的预发布冒烟验证会连接真实模型和 Business Capability，检查结构化成功结果与安全失败响应，但不依赖精确文案。
- [x] 发布说明明确把公网匿名访问、应用鉴权、多租户、数据库、通用幂等、队列、自动重试、图片与 OSS 生产链路以及全量基础设施即代码留在本次 MVP 范围之外。

## Answer

Implemented and verified a multi-stage Node.js 24 image that runs as UID 1000, carries production dependencies, compiled output, and only the reviewed content Skill. The final image passed health, request-boundary, structured-log, safe-configuration, packaging, and local deployed-service smoke checks. The release runbook defines platform authentication/TLS/private-ingress gates, bounded scaling and timeout baselines, secret injection, build/health/smoke/rollback procedures, real Agent plus Business Capability release validation, and the deferred production capabilities.
