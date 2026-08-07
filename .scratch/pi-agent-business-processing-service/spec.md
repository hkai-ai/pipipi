# Spec: 基于 pi-coding-agent 的通用业务处理服务

Status: ready-for-agent

## Problem Statement

多个产品需要执行相似的业务数据和内容处理，包括输入准备、业务数据补充、内容生成、质量优化、合规校验和输出整理。目前如果这些逻辑分别留在产品内部，每个产品都需要重复集成业务接口、模型、Agent、Skill、错误处理和运行治理，导致能力难以复用、行为难以统一、升级成本高。

需要将这些处理能力抽离为一个可被多个业务产品调用的独立业务处理服务。该服务既要支持确定性的本地逻辑和远程接口调用，也要允许某些确实需要语义理解、动态决策或多步推理的处理阶段使用 pi-coding-agent。产品调用方不应了解某个阶段内部使用的是本地代码、远程接口、直接模型调用还是 Agent。

同时，不能把 pi 的 Skill 错误地当成所有业务处理的通用执行插件。Skill 是供 Agent 按需加载的操作指南和能力包；确定性业务能力需要拥有独立、可测试的接口，并可在需要时适配为 Agent Tool。

## Solution

建设一个独立的业务处理服务。服务通过一个小而稳定的执行接口接收流程标识、流程版本、业务输入和请求上下文，运行已注册的业务流程，并返回经过校验的结构化结果或明确的结构化错误。

每个业务流程在代码中定义自己的业务阶段、数据流、分支、异常处理和业务不变量。流程阶段只表达业务语义，例如“补充商品信息”“生成内容”“执行合规检查”，不把“预处理”“后处理”强制为所有业务都必须遵循的固定模型。

模型选择、Prompt/Skill 版本、Tool 白名单、超时、重试、质量阈值、开关和灰度策略等高频变化项由经过 Schema 校验的 JSON 配置提供。JSON 不定义任意业务程序，不支持任意脚本、URL、循环或表达式，也不允许产品调用方在单次请求中上传流程定义。

业务能力通过独立接口复用，可由本地实现或远程接口 Adapter 提供。流程可以直接调用业务能力；如果 Agent 也需要使用同一能力，则通过一个 pi Tool Adapter 将其暴露给 Agent。pi-coding-agent SDK 被封装在 Agent Runtime 后面，只在业务流程确实需要推理时使用。Skill 只负责指导 Agent 如何完成特定任务以及如何组合获准的 Tool。

第一版提供同步、顺序执行为主的处理能力，并至少实现一个“准备输入、生成内容、整理输出”的示例业务流程，以验证从产品调用、流程运行、直接业务能力调用到可选 Agent 执行的完整链路。

## User Stories

1. As a 产品开发者, I want to submit business input to a named processing process, so that my product does not need to implement the processing logic itself.
2. As a 产品开发者, I want to request an explicit process version, so that a service upgrade does not silently change my product's behavior.
3. As a 产品开发者, I want to receive a structured output that follows a documented schema, so that I can consume the result without parsing conversational text.
4. As a 产品开发者, I want invalid input to be rejected before processing starts, so that malformed requests fail predictably.
5. As a 产品开发者, I want failures to identify whether they came from validation, a dependency, Agent execution, policy enforcement, or timeout, so that my product can apply the correct fallback.
6. As a 产品开发者, I want every execution to return a run identifier, so that I can correlate product requests with service diagnostics.
7. As a 产品开发者, I want to provide an idempotency key when retrying a request, so that transient network failures do not accidentally create duplicate processing runs.
8. As a 产品开发者, I want the processing service to hide whether a result was produced by local logic, a remote interface, a direct model call, or an Agent, so that implementation changes do not affect my integration.
9. As a 产品开发者, I want to provide business context such as tenant, locale, channel, and trace identifiers through a defined request context, so that the selected process can apply the correct business policy.
10. As a 产品开发者, I want the service to return only safe diagnostics, so that credentials, internal prompts, and sensitive business data are not leaked to my product or end users.
11. As a 流程开发者, I want to define a process in typed code, so that control flow, data transformations, and error behavior can be reviewed and tested with normal engineering tools.
12. As a 流程开发者, I want each process to declare input and output schemas, so that its contract can be validated at registration and execution time.
13. As a 流程开发者, I want to give stages domain-specific names, so that the process expresses business meaning instead of generic pre-process/post-process mechanics.
14. As a 流程开发者, I want to compose a process from reusable business capabilities, so that common behavior is implemented once and reused by multiple businesses.
15. As a 流程开发者, I want to call a remote business interface directly from a deterministic stage, so that the stage does not incur Agent cost or nondeterminism unnecessarily.
16. As a 流程开发者, I want to call local deterministic logic directly, so that simple transformations remain fast and reliable.
17. As a 流程开发者, I want to invoke the Agent Runtime only for stages requiring semantic understanding or dynamic decisions, so that Agent usage remains intentional.
18. As a 流程开发者, I want branching, fallback, and compensation behavior to remain in code, so that complex behavior does not become an untyped JSON programming language.
19. As a 流程开发者, I want dependencies to be supplied through the process context, so that process behavior can be tested without real remote services.
20. As a 流程开发者, I want structured Agent output to be validated before it enters the next stage, so that model responses cannot corrupt the rest of the process.
21. As a 流程开发者, I want to define an explicit fallback when Agent execution fails or produces invalid output, so that each business process controls its own degradation behavior.
22. As a 业务能力开发者, I want a capability to expose one stable business interface regardless of whether its implementation is local or remote, so that callers do not depend on transport details.
23. As a 业务能力开发者, I want the same capability to be callable directly by a process and indirectly through an Agent Tool Adapter, so that reuse happens in the business capability rather than in duplicated wrappers.
24. As a 业务能力开发者, I want remote interfaces to be represented by replaceable Adapters, so that tests can use in-memory or fake implementations.
25. As an Agent 能力开发者, I want pi Skills to contain task guidance, workflows, references, and helper instructions, so that the Agent can load specialized knowledge only when relevant.
26. As an Agent 能力开发者, I want executable business operations to be registered as pi Tools with validated parameters, so that Agent actions are bounded and observable.
27. As an Agent 能力开发者, I want each process to define a Tool and Skill allowlist, so that the Agent cannot access unrelated capabilities.
28. As an Agent 能力开发者, I want coding-oriented filesystem, shell, edit, and write tools to be disabled by default, so that a business data request cannot obtain unnecessary machine access.
29. As an Agent 能力开发者, I want every Agent invocation to use an isolated execution session, so that context and data cannot leak between business requests.
30. As a 配置维护者, I want to configure model selection and inference settings without modifying process control-flow code, so that operational tuning does not require redesigning a process.
31. As a 配置维护者, I want to configure Prompt, Skill, and Tool versions or allowlists, so that Agent behavior can evolve under explicit version control.
32. As a 配置维护者, I want to configure timeouts, retries, thresholds, feature switches, and rollout percentages, so that operational policy can change safely.
33. As a 配置维护者, I want configuration to be validated against a strict schema at startup, so that invalid settings fail before production traffic is accepted.
34. As a 配置维护者, I want configuration to reference only registered capabilities and policies, so that it cannot introduce arbitrary scripts, URLs, or unreviewed executable behavior.
35. As a 配置维护者, I want secrets to remain outside JSON process configuration, so that configuration can be reviewed and versioned safely.
36. As a 平台维护者, I want a process registry to reject duplicate process identifiers and versions, so that routing is deterministic.
37. As a 平台维护者, I want process versions to coexist, so that multiple products can upgrade independently.
38. As a 平台维护者, I want the service to record process, version, duration, stage outcome, dependency calls, Agent usage, token usage, and final status, so that executions can be operated and audited.
39. As a 平台维护者, I want logs and traces to redact configured sensitive fields, so that observability does not become a data-leak path.
40. As a 平台维护者, I want per-stage and total execution timeouts, so that a slow dependency or Agent cannot hold resources indefinitely.
41. As a 平台维护者, I want retry policy to distinguish retryable dependency failures from permanent business failures, so that retries do not amplify invalid requests or side effects.
42. As a 平台维护者, I want Agent cost and token metrics to be attributable to process, version, and business tenant, so that usage can be governed.
43. As a 平台维护者, I want execution cancellation to propagate to active remote and Agent calls where supported, so that abandoned requests stop consuming resources.
44. As a 安全与合规负责人, I want every Tool invocation to be attributable to a run and process, so that Agent actions are auditable.
45. As a 安全与合规负责人, I want products to be authorized for specific processes and versions, so that one business cannot invoke capabilities intended for another.
46. As a 安全与合规负责人, I want business data to remain isolated between requests and tenants, so that shared service operation does not create cross-tenant exposure.
47. As a 测试开发者, I want to exercise a complete process through the same execution interface used by product callers, so that tests verify observable business behavior rather than internal stage wiring.
48. As a 测试开发者, I want fake capability and Agent Runtime Adapters, so that normal test suites remain deterministic, fast, and free of model cost.
49. As a 测试开发者, I want contract tests for production Adapters, so that local fakes and remote integrations agree on the same capability interface.
50. As a 测试开发者, I want optional end-to-end smoke tests against a configured model provider, so that the pi-coding-agent integration can be verified without making nondeterministic model calls part of every CI run.
51. As a 维护者, I want adding a new process to require registration, schemas, configuration, and high-level behavior tests, so that the service grows through a consistent extension path.
52. As a 维护者, I want implementation choices such as direct interface versus Agent to remain internal to the processing service, so that product integrations stay stable during refactoring.

## Implementation Decisions

- The system will be implemented as an independently deployable business processing service with a transport-independent core and an initial JSON request/response transport Adapter.
- The external interface will expose execution of a registered process using a process identifier, explicit process version, business input, request context, and optional idempotency key. Products will not submit stage graphs or choose implementation mechanisms.
- The initial execution model will be synchronous request/response with enforced total and per-dependency timeouts. Durable asynchronous jobs are not part of the first version.
- A Process Registry will own the mapping from process identifier and version to a Process Definition. Duplicate registrations and invalid definitions will fail during startup.
- A Process Definition will own its input schema, output schema, orchestration, business stages, branching, fallback, and error mapping.
- Process stages will be internal implementation details with domain-specific names. The framework will not require every process to use generic pre-processing, generation, and post-processing stages.
- Process control flow will be defined in typed code. The first version will not implement a general JSON workflow interpreter.
- JSON configuration will be restricted to stable, schema-validated variation points such as model configuration, Prompt/Skill references, Tool allowlists, timeouts, retry policy, thresholds, switches, and rollout policy.
- JSON configuration will reference registered identifiers rather than contain arbitrary executable code, arbitrary remote URLs, credentials, loops, or expressions.
- Configuration will be service-owned and version controlled. Product callers will provide business options only when those options are part of the process contract; they will not override infrastructure or Agent policy per request.
- Reusable deterministic behavior will be modeled as Business Capability modules with small interfaces. Implementations may be local or supplied through remote-service Adapters.
- A process will call a Business Capability interface directly when no Agent judgment is required.
- When an Agent needs the same Business Capability, a pi Tool Adapter will expose that existing interface with a validated Tool parameter and result schema. Business behavior will not be duplicated inside the Tool.
- pi Skill will retain its pi-coding-agent meaning: an Agent-loaded package of instructions, workflow guidance, references, assets, and optional helper scripts. Skill will not be the base interface for deterministic process stages.
- pi-coding-agent SDK integration will be isolated behind an Agent Runtime interface so Process Definitions do not depend on SDK session details.
- Each Agent invocation will receive an isolated session and an explicit Skill and Tool allowlist. Cross-request conversation history will not be reused.
- Default coding tools that provide shell or filesystem mutation will be disabled. A process must explicitly register and allow a business-safe Tool before the Agent can invoke it.
- Agent output consumed by a process will be structured and schema validated. Free-form model text will not flow directly into later deterministic stages unless the Process Definition explicitly treats text as its contract.
- The process owns the fallback when an Agent or dependency fails. The framework will provide common typed failures and retry primitives but will not invent a universal business fallback.
- External and Agent dependencies will be injected through an Execution Context. Production Adapters and deterministic test Adapters will satisfy the same internal interfaces.
- The execution result will include a run identifier, process identifier, version, status, and either validated business output or a structured safe error. Internal prompts, credentials, stack traces, and sensitive payloads will not be returned.
- The runtime will produce structured execution records covering overall duration, stage outcomes, remote calls, Agent and Tool activity, retry attempts, token/cost metadata when available, and final status.
- Sensitive data redaction will be applied before logs, traces, and externally visible diagnostics are emitted.
- Process authorization and tenant context will be enforced at the external execution seam before a Process Definition runs.
- Idempotency support will be available to callers that supply an idempotency key. The implementation will avoid repeating a completed execution for the same authorized caller, process version, and key.
- The initial implementation will include at least one representative content-processing process that prepares an input, obtains or generates content through a deterministic or Agent-backed policy, and finalizes a validated output.
- The implementation will pin and record the selected pi-coding-agent package version. Any package namespace or compatibility choice will be resolved during dependency setup without leaking into Process Definition interfaces.

## Testing Decisions

- The primary test seam will be the highest practical seam: a product-like caller executes a registered process through the external execution interface and asserts the validated output or structured error. Tests will not assert internal stage objects, private method calls, or whether an internal refactor used a local implementation versus a remote Adapter unless that difference is externally contractual.
- High-level process tests will run the real Process Registry, schema validation, configuration validation, Process Definition, error mapping, and result construction while replacing remote Business Capability and Agent Runtime dependencies with deterministic in-memory Adapters.
- The representative content-processing process will be tested for valid input, invalid input, successful deterministic processing, successful Agent-backed processing, invalid Agent output, dependency timeout, retryable dependency failure, permanent business failure, configured fallback, cancellation, idempotent retry, and sensitive diagnostic redaction.
- Version-routing tests will prove that two versions of one process can coexist and that callers receive the explicitly requested behavior.
- Authorization and tenant-isolation tests will prove that an unauthorized product cannot execute a process and that execution context does not cross requests.
- Configuration tests will prove that unknown process, capability, Skill, Tool, model-policy, or Adapter references fail before traffic is served, and that executable expressions, arbitrary URLs, and secrets are not accepted as process control flow.
- Business Capability interfaces with remote implementations will have Adapter contract tests. The same contract suite will run against the in-memory test Adapter and, where practical, a controlled production-like Adapter.
- The pi Agent Runtime Adapter will have focused integration tests for session isolation, allowed Tool exposure, Skill loading, structured output capture, cancellation, timeout, and error translation.
- Real-model tests will be optional smoke tests outside the default deterministic suite because model behavior, cost, credentials, and provider availability are nondeterministic. They will validate integration health rather than exact prose.
- Observability tests will assert the presence of run correlation, process version, stage status, Tool invocation, retry, and token metadata while asserting that configured sensitive fields and credentials are absent.
- Tests will assert externally observable outcomes and stable contracts. They will avoid snapshotting prompts, private stage sequences, SDK event ordering, or internal configuration object shapes unless those details become part of a documented interface.
- There is no existing codebase or test prior art in the current project directory. The initial suite will establish the external-execution test style that later processes and Adapters must follow.

## Out of Scope

- A visual workflow editor or no-code process builder.
- A general-purpose JSON workflow language with arbitrary branching, loops, scripts, expressions, or remote URLs.
- Allowing products to upload a process definition or select local, interface, model, or Agent execution per request.
- Requiring every process to conform to fixed pre-processing, generation, and post-processing stages.
- Treating every Business Capability or remote interface as a pi Skill.
- Persistent multi-turn conversational memory shared across business requests.
- General coding-agent filesystem, shell, code-editing, or repository-management capabilities.
- Dynamic installation of unreviewed third-party Skills or extensions at request time.
- A durable distributed workflow engine, queues, scheduled runs, or long-running asynchronous jobs in the first version.
- A multi-Agent orchestration framework in the first version.
- A business-user administration UI for authoring processes or configuration.
- Production-specific content rules for every consuming business; the first version includes one representative process and the extension mechanism.
- Model training, fine-tuning, evaluation-dataset management, or provider billing reconciliation.

## Further Notes

- The current project directory contains no repository files, Git history, domain glossary, ADRs, or existing tests. This specification therefore establishes an initial vocabulary rather than deriving one from existing project documentation.
- Initial vocabulary: a **Business Process** is a versioned business use case exposed to products; a **Process Definition** is its code-owned implementation; a **Stage** is an internal domain-specific portion of that implementation; a **Business Capability** is reusable deterministic business behavior; an **Adapter** connects a capability interface to a local, remote, test, transport, or pi implementation; **Agent Runtime** is the optional pi-coding-agent execution interface; a **Tool** is an executable operation exposed to the Agent; a **Skill** is Agent guidance loaded on demand; an **Execution Context** carries authorized dependencies and request-scoped metadata; a **Run Record** is the observable execution history.
- The architectural principle is “code defines behavior; configuration selects validated policy.” New behavior remains reviewable and testable code, while operational choices can change without turning JSON into a second programming language.
- The processing service earns its deployment seam only if removing it would cause processing rules, Agent integration, capability integration, and operational governance to be duplicated across consuming products. It must not degrade into a thin remote pass-through.
- The chosen test seam matches the intended product experience: execute one named, versioned Business Process and observe its result. Internal seams exist only for true external dependencies that need production and deterministic test Adapters.
- Because the directory has no configured remote issue tracker, this spec is published using the supported local Markdown tracker convention under `.scratch/`.
