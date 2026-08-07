# 04 — 让文本内容处理服务达到受控 MVP 上线标准

**Status:** resolved

**Blocked by:** 01 — 跑通一个直接调用 API 的业务流程；02 — 为流程加入可选的 Pi Agent 优化；03 — 增加第二个业务流程并验证能力复用。三张前置票均已 resolved。

## Problem Statement

现有业务处理服务已经能够通过统一执行接口运行版本化 Business Process，也能在服务端选择直接 Business Capability 或隔离的 Agent Runtime。输入输出 Schema、稳定错误映射、总超时、受限 Tool 和请求级 Agent 会话已经建立，自动化测试也覆盖了主要业务行为。

产品团队现在希望先上线文本内容处理 MVP，供少量受控调用方验证真实业务价值。当前仓库仍缺少可重复部署的容器、私有访问边界、请求体和执行并发保护、健康检查、最小运行日志，以及连接真实 Business Capability 和模型提供方后的发布验证。直接暴露现有服务会放大未授权调用、超大请求、无限并发、模型费用失控和故障难以定位的风险。

同时，MVP 不应为了未来的公网、多租户或长任务场景提前建设通用鉴权系统、数据库、队列、幂等平台或完整可观测性平台。需要明确一条窄上线边界：补齐文本服务安全运行所需的最小能力，保留现有业务契约，并把生产级扩展能力显式延后。

## Solution

把现有同步业务处理服务包装为可重复构建的 Node.js 24 Linux 容器，完整携带运行时代码和已审核 Skill，并通过部署平台或可信网关提供 TLS、私有入口和调用方认证。模型凭证、Business Capability 地址和其他敏感配置只由部署平台注入。

保持产品调用方现有的 `POST /execute` 契约不变。在 HTTP Adapter 增加固定且可配置的请求体字节上限、JSON 媒体类型校验和实例内执行并发闸门。超限、媒体类型错误和容量饱和使用稳定的传输层错误响应；Process Runner 继续负责业务输入、流程路由、依赖、Agent 和总超时错误。

增加不访问外部依赖的 `GET /healthz`，并为每个执行结果输出一条字段白名单控制的 JSON Run Record 摘要。日志只包含运行标识、Business Process、版本、状态、耗时和安全错误码，不记录业务输入、业务输出、Prompt、Tool 参数或凭证。

把真实 Business Capability 和一次真实 Agent 请求作为发布门禁，而不是默认测试依赖。默认测试继续使用受控 Adapter，从产品调用方的最高层 HTTP seam 验证完整行为。首版明确限制为文本内容处理和少量受控调用方；图片、OSS 生产链路、浏览器直连、通用幂等和异步作业不进入本规格。

## User Stories

1. As a 产品调用方, I want to keep using the existing process, version, and input request shape, so that MVP hardening does not force product integration changes.
2. As a 产品调用方, I want successful executions to keep returning a run identifier and validated output, so that I can correlate results with service diagnostics.
3. As a 产品调用方, I want invalid business input to keep returning a stable structured error, so that my product can handle bad requests predictably.
4. As a 产品调用方, I want oversized requests to fail before model or Business Capability execution starts, so that an accidental payload cannot consume unbounded service resources.
5. As a 产品调用方, I want a stable capacity-saturated response with retry guidance, so that I can back off instead of creating a retry storm.
6. As a 产品调用方, I want the service to accept standard JSON content types with optional charset parameters, so that ordinary HTTP clients interoperate correctly.
7. As a 产品调用方, I want unsupported media types to fail explicitly, so that transport errors are not confused with invalid business data.
8. As a 产品调用方, I want direct and Agent-backed processing to retain the same external contract, so that implementation policy remains a server concern.
9. As a 产品负责人, I want the first release limited to text processing, so that the team can validate demand before building image and long-running workflows.
10. As a 产品负责人, I want explicit cost guardrails around concurrent Agent executions and instance count, so that an MVP traffic spike cannot create open-ended model spend.
11. As a 产品负责人, I want a documented small-traffic launch profile, so that operators have a safe starting configuration rather than guessing production values.
12. As a 平台维护者, I want one reproducible Linux container build, so that local, ECS, SAE, ACK, Cloud Run, and other container platforms run the same artifact.
13. As a 平台维护者, I want the runtime image to use Node.js 24 and production dependencies only, so that it matches the service contract without shipping development tooling.
14. As a 平台维护者, I want the reviewed content optimization Skill included in the runtime image, so that Agent mode does not fail after deployment.
15. As a 平台维护者, I want the service process to run as a non-root user, so that a container compromise has fewer privileges.
16. As a 平台维护者, I want local dependencies, build artifacts, credentials, experiment reports, and repository metadata excluded from the build context, so that images stay smaller and do not leak local data.
17. As a 平台维护者, I want the service to continue listening on the platform-provided port and all container interfaces, so that managed container routing works without entrypoint changes.
18. As a 平台维护者, I want invalid required configuration to stop startup with a clear safe error, so that a broken revision never accepts traffic.
19. As a 平台维护者, I want model and downstream credentials injected as secrets, so that no credential enters source control or the container image.
20. As a 平台维护者, I want a real reachable Business Capability configured before launch, so that the deployed service does not depend on the localhost demonstration server.
21. As a 平台维护者, I want a lightweight health endpoint that never calls the model or Business Capability, so that probes remain fast and stable during dependency incidents.
22. As a 平台维护者, I want health checks to reveal no configuration or dependency details, so that probes do not become an information-disclosure endpoint.
23. As a 平台维护者, I want a configurable raw request-body limit with a conservative default, so that deployments can tune input size without changing Process Definitions.
24. As a 平台维护者, I want a configurable maximum number of in-flight executions per instance, so that memory use and outbound model concurrency remain bounded across container platforms.
25. As a 平台维护者, I want every acquired execution slot released after success, failure, or timeout, so that one failed request cannot permanently reduce capacity.
26. As a 平台维护者, I want the deployment platform to cap maximum instances, so that horizontal scaling remains bounded by a deliberate cost ceiling.
27. As a 平台维护者, I want the platform request timeout longer than the Process Runner timeout, so that the application can return its own stable timeout response before the platform closes the connection.
28. As a 平台维护者, I want the existing graceful shutdown behavior preserved, so that rolling deployments stop accepting new work and allow active requests to finish.
29. As a 平台维护者, I want unexpected request-handler failures mapped to a safe HTTP error and logged, so that rejected promises do not escape the server boundary.
30. As a 平台维护者, I want one structured completion log per `/execute` request, so that I can search executions by run identifier and outcome.
31. As a 平台维护者, I want completion logs to include process, version, status, duration, and safe error code, so that MVP incidents can be diagnosed without a separate database.
32. As a 平台维护者, I want logs to use an explicit field allowlist, so that business content and credentials cannot appear through accidental object serialization.
33. As a 平台维护者, I want rejected transport requests and capacity rejections logged without their body, so that abuse and configuration mistakes remain observable without exposing content.
34. As a 平台维护者, I want stdout-compatible JSON logs, so that the chosen container platform can collect them without a vendor-specific SDK.
35. As a 安全负责人, I want the service reachable only through a private ingress or trusted gateway, so that arbitrary internet clients cannot spend model quota.
36. As a 安全负责人, I want TLS and caller authentication enforced at the deployment perimeter, so that MVP access is protected without building an application user system.
37. As a 安全负责人, I want the container port inaccessible except from the trusted ingress, so that callers cannot bypass gateway controls.
38. As a 安全负责人, I want the current Agent Skill and Tool allowlist preserved, so that deployment hardening does not expose coding, filesystem, or Shell capabilities.
39. As a 安全负责人, I want request-local Agent sessions preserved under concurrency, so that business content cannot cross requests.
40. As a 流程开发者, I want transport admission controls kept outside Process Definitions, so that business orchestration remains independent of HTTP and deployment policy.
41. As a 流程开发者, I want Process Runner error semantics preserved, so that transport hardening does not collapse Agent, dependency, validation, routing, and timeout failures into one error.
42. As a 测试开发者, I want tests to call the service through the same HTTP execution seam used by products, so that tests cover routing, admission, execution, error mapping, and response serialization together.
43. As a 测试开发者, I want deterministic fake Business Capability and Agent Runtime Adapters in the default suite, so that tests stay fast, repeatable, and free of model cost.
44. As a 测试开发者, I want concurrent HTTP requests with distinct sentinel content, so that capacity enforcement and cross-request isolation are proven together.
45. As a 测试开发者, I want container startup and health verified from the built image, so that a passing TypeScript suite cannot hide a packaging failure.
46. As a 测试开发者, I want one opt-in staging smoke test against the configured model and real Business Capability, so that release validation covers the integration without making every CI run nondeterministic.
47. As a 维护者, I want future side-effecting Business Processes to require a separate idempotency decision before launch, so that this text-only exception does not silently become a general policy.
48. As a 维护者, I want unrelated OSS and image-generation work preserved, so that MVP hardening neither deletes it nor makes it a dependency of the text service.

## Implementation Decisions

- This issue hardens the existing independently deployable business processing service; it does not introduce a second service or replace the Process Registry, Process Runner, Process Definition, Business Capability, Adapter, or Agent Runtime abstractions.
- The launch scope covers the existing text Business Processes. `content-processing` may run in direct or Agent mode according to server configuration; `titled-content-processing` retains its current direct Business Capability path.
- The product-facing `POST /execute` request and successful response contracts remain unchanged. Products still provide a registered process identifier, explicit version, and business input; they cannot select Agent mode, Tool access, remote addresses, or deployment policy.
- The HTTP Adapter adds `GET /healthz`. A healthy initialized process returns HTTP 200 with a fixed minimal JSON body. The health check does not call a model, Agent Runtime, Tool, Business Capability, object store, or other remote dependency.
- The HTTP Adapter accepts `application/json` media types, including parameters such as UTF-8 charset. Other media types return HTTP 415 with a stable `UNSUPPORTED_MEDIA_TYPE` transport error.
- Raw request bodies are limited by bytes, not JavaScript character count. `HTTP_MAX_REQUEST_BODY_BYTES` is a positive integer with a default of 262144 bytes. A declared or streamed body above the limit returns HTTP 413 with a stable `REQUEST_TOO_LARGE` transport error before Process Runner execution.
- Transport errors remain separate from `ProcessErrorCode`, because they occur before a Process Run exists. They follow the existing safe failed-response shape but do not invent a run identifier for work that never entered Process Runner.
- The application adds an instance-local execution admission controller. `MAX_CONCURRENT_EXECUTIONS` is a positive integer with a default of 4. It limits calls that enter Process Runner, not health checks or rejected transport requests.
- When all execution slots are occupied, the HTTP Adapter returns HTTP 503 with a stable `SERVICE_BUSY` transport error and a short `Retry-After` header. It does not queue unbounded work in process memory.
- The admission controller releases its slot in a `finally` path after success, structured failure, unexpected failure, or timeout. It does not serialize executions below the configured limit.
- Deployment configuration also sets a finite maximum instance count. The documented MVP baseline is 2–4 concurrent executions per instance and 2–5 maximum instances; operators must tune upward only after observing memory, latency, downstream capacity, model quotas, and cost.
- The existing Business Capability timeout and Process Runner timeout remain authoritative. Deployment documentation requires the platform request timeout to exceed the Process Runner timeout, with an initial profile of 10 seconds for the Business Capability, 120 seconds for the Process Run, and 150–180 seconds for the platform request.
- The HTTP server catches unexpected asynchronous handler failures at its boundary. It returns a safe HTTP 500 response when possible and emits a redacted failure log without stack traces or secrets in the client response.
- The application exposes a small injectable log sink for tests and defaults to one-line JSON records on stdout. Logging remains an Adapter concern and does not enter Process Definitions.
- Every completed Process Run emits exactly one `process_run_completed` record containing event name, timestamp, run identifier, process identifier, version, final status, duration in milliseconds, and safe error code when present.
- Transport rejection and capacity rejection records contain only an event name, timestamp, HTTP status, safe error code, and duration when meaningful. Log construction uses explicit fields; it never spreads requests, results, caught errors, environment objects, model messages, Tool input, business input, or business output.
- Duration measurement uses a monotonic clock where available. Tests may inject a clock or log sink, but production callers do not see timing implementation details.
- The service is packaged as a multi-stage Linux container based on Node.js 24. The build stage installs locked dependencies and compiles the service. The runtime stage installs production dependencies, copies compiled output and the reviewed content-optimization Skill, and runs as a non-root user.
- The container build context excludes local dependency directories, compiled output, `.env` files, credentials, artifacts, experiment reports, repository metadata, and scratch tracker material.
- Runtime configuration continues to arrive through environment variables and platform secret injection. The container image contains no `.env` file, API key, OSS credential, Business Capability credential, or local Pi authentication directory.
- `BUSINESS_API_BASE_URL` must identify a production-reachable Business Capability. The localhost demonstration API remains a development aid and is not packaged as the production dependency.
- The MVP deployment perimeter, not application code, provides TLS and caller authentication. Acceptable deployments use private ingress or a trusted authenticated gateway and prevent direct public access to the container port. The specification does not add end-user accounts, sessions, tenants, or process-level RBAC.
- The service does not add CORS. Browser products call through an existing backend or BFF during the MVP.
- The release runbook documents environment variables, secret names, container build and start commands, health configuration, private-ingress requirement, concurrency, maximum instances, timeouts, rollback, and the real integration smoke command.
- A release candidate must pass deterministic tests, build the production container, start that image with production-shaped configuration, pass the health probe, reach the configured Business Capability in a controlled environment, and complete one opt-in real Agent request when Agent mode is enabled.
- The default suite never invokes a real model, consumes provider quota, depends on cloud credentials, or uploads to OSS. Real integration checks remain explicit release steps.
- Existing request-local Agent sessions, explicit Skill selection, Tool allowlist, structured Agent output validation, safe error mapping, total timeout, and graceful shutdown behavior remain unchanged unless required to connect them to the new HTTP controls and logging.

## Testing Decisions

- The primary and preferred test seam is the existing highest-level HTTP seam: a product-like caller starts the Processing Application, sends HTTP requests, and asserts only status, headers, safe response body, externally visible logs, and calls observed by injected external-dependency Adapters.
- Tests extend the existing pattern that runs the real HTTP Adapter, Process Registry, Process Runner, Process Definitions, Schema validation, and error mapping while replacing the remote Business Capability and Agent Runtime with deterministic fakes.
- A health test calls `GET /healthz`, expects the fixed 200 response, and proves that neither Business Capability nor Agent Runtime runs.
- Media-type tests prove that JSON with and without charset is accepted and that a non-JSON media type returns 415 without entering Process Runner.
- Body-limit tests cover a declared oversized request and a chunked request that crosses the limit. Both return 413, expose no submitted content, and make no Business Capability or Agent call.
- Capacity tests configure a limit of two, hold two deterministic executions open, and prove that a third request receives 503 plus `Retry-After`. After one execution completes, a new request succeeds.
- Slot-release tests exercise success, Process Failure, unexpected failure, and timeout. Each path must restore capacity; tests assert observable acceptance of a later request rather than inspecting semaphore internals.
- Concurrent-isolation tests send distinct sentinel content through parallel requests and assert that each response and Business Capability call contains only its own sentinel.
- Regression tests keep the existing direct content process, Agent-backed content process, titled content process, invalid input, version routing, dependency failure, Agent failure, and timeout behaviors unchanged.
- Logging tests capture the injected sink while issuing HTTP requests. They assert one completion record per Process Run, required correlation fields, stable failure codes, and the absence of request content, response content, Prompt text, Tool parameters, API keys, authorization values, stack traces, and raw caught errors.
- Unexpected handler-failure tests verify a safe 500 response when the connection is still writable and a redacted structured log. Tests do not assert internal stack shape or private method calls.
- Configuration parsing receives focused tests because invalid concurrency and body-limit values prevent the HTTP server from starting and cannot be observed through an already running endpoint. Undefined values use the documented defaults; zero, negative, fractional, empty, and non-numeric values fail startup.
- Container verification builds the production image, starts it with a non-secret production-shaped environment, checks that the process runs as a non-root user, and calls the health endpoint. Agent-mode packaging verification confirms the reviewed Skill exists inside the image without sending a model request.
- Deployment verification confirms the public network cannot reach the container directly and an authorized path can reach it through the selected private ingress or gateway. This is an environment acceptance check, not a unit test of application authentication.
- One opt-in staging smoke uses the configured real model and Business Capability. It asserts successful structured output and safe failure reporting, not exact prose. It remains outside the default deterministic suite because credentials, cost, latency, and model output are nondeterministic.
- The full existing typecheck and deterministic test suite must pass. Tests should avoid snapshots of logs or whole response objects when assertions on stable fields express the contract more clearly.

## Out of Scope

- Public unauthenticated access to `/execute`.
- Application-managed end-user authentication, sessions, tenants, process-level authorization, or RBAC.
- Direct browser invocation, CORS, browser tokens, or a new BFF.
- Persistent Run Records, a database, execution-history APIs, dashboards, or audit retention.
- General idempotency keys or deduplication for the current side-effect-free text processes. Any future Business Process that publishes, charges, sends, mutates business state, or triggers another irreversible action must add idempotency before launch.
- Durable queues, asynchronous `202 Accepted` jobs, polling endpoints, callbacks, scheduled work, resumable execution, or distributed workflow engines.
- Automatic retries of model or Business Capability calls. MVP callers must use bounded manual retry behavior for safe text operations.
- Full distributed tracing, per-tenant quotas, token accounting, cost attribution, SLO automation, or a vendor-specific observability SDK.
- Immediate cancellation when a client disconnects. Existing bounded Process Runner and dependency timeouts remain the MVP resource boundary.
- OpenAPI publication, generated client SDKs, or a developer portal.
- Implementing or deploying the real Business Capability itself; this issue only requires a reachable configured dependency and verifies the Adapter contract.
- Production image generation, image-generation endpoints, visual quality retries, OSS persistence, signed image delivery, CDN policy, or browser uploads.
- Changing or removing concurrent OSS and image experiment work already present in the workspace.
- Infrastructure-as-code for every supported cloud, multi-region traffic, disaster recovery, zero-downtime database migration, or active-active deployment.
- Persistent conversational memory, multi-Agent orchestration, MCP, arbitrary Shell or filesystem tools, or dynamic installation of Skills.

## Further Notes

- The project vocabulary remains: a Business Process is a versioned use case; a Process Definition owns typed orchestration; a Business Capability provides reusable deterministic behavior; an Adapter connects transport or remote implementations; Agent Runtime encapsulates pi-coding-agent; a Skill guides the Agent; a Tool exposes an approved executable operation; and a Run Record describes an execution outcome.
- The selected test seam matches the product experience already established by the first three issues. New controls are accepted primarily through `/execute`; only startup-only configuration, built-container behavior, and deployment-perimeter access require separate acceptance seams.
- The service already permits asynchronous concurrent requests and creates a fresh in-memory Agent session for each invocation. This issue bounds admission; it does not introduce concurrency by serializing or pooling Agent conversations.
- As of 2026-08-08, TypeScript checking, the production no-emit build check, and all 32 deterministic tests pass in the current workspace. These checks do not replace the required built-container and real-integration release gates.
- The current workspace contains unrelated in-progress OSS and image-generation changes. Implementation must preserve them and avoid making the text MVP depend on their completion.
- If the launch boundary changes to public browser users, untrusted third parties, side-effecting Tools, image generation, or long-running work, the deferred authentication, idempotency, storage, CORS, and queue decisions must be revisited before release.

## Answer

Implemented all five MVP hardening tickets. The service now has a safe HTTP boundary and dependency-free health endpoint, byte and media-type admission controls, bounded fail-fast instance concurrency, redacted structured run logs, safe startup configuration, a production Node.js 24 container, and executable deterministic and staging release gates. The full deterministic suite, typecheck, build, code review, clean-diff checks, final-image packaging checks, and a deployed-container smoke against a controlled Business Capability all pass. Real provider credentials, authenticated private ingress/TLS, public-bypass denial, platform instance limits, and the opt-in real-model smoke remain explicit environment release gates and are documented rather than embedded in application code.
