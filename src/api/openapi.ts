/** 从 ProcessRegistry 派生 OpenAPI 3.1.0 公开契约与单 Process 切片，严格隔离服务端内部配置。 */
import { z } from "zod";
import type {
    ProcessRegistration,
    ProcessRegistry,
} from "../process-runtime/index.js";

const jsonSchemaDialect = "https://json-schema.org/draft/2020-12/schema";
const defaultServerUrl = "https://pi.ganjiuwanshi.com";
const defaultTimeoutMsFallback = 30_000;

export type OpenApiOptions = Readonly<{
    defaultProcessTimeoutMs?: number;
    serverUrl?: string;
    version?: string;
}>;

export type OpenApiCatalog = Readonly<{
    document: Buffer;
    processSlice: (process: string, version: string) => Buffer | undefined;
}>;

/** 将 kebab-case 与版本转为稳定可读的组件名前缀（如 product-remix/v1 -> ProductRemixV1）。 */
export function openApiComponentPrefix(
    processId: string,
    version: string,
): string {
    const pascalId = processId
        .split(/[^a-zA-Z0-9]+/u)
        .filter(Boolean)
        .map((segment) => (segment[0]?.toUpperCase() ?? "") + segment.slice(1))
        .join("");
    const normalizedVersion = version
        .replace(/[^a-zA-Z0-9]+/gu, "_")
        .replace(/^v/u, "V");
    return `${pascalId}${normalizedVersion}`;
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * 递归提升任意层级的 `$defs` 至目标容器（OpenAPI 的 `components.schemas` 或单切片顶层 `$defs`），
 * 剥离嵌套 `$schema` / `$id`，并对结构完全一致的定义执行迭代内容去重，消除悬空 `#/$defs/*` 引用。
 */
class DefsHoister {
    private readonly target: Record<string, unknown>;
    private readonly refPrefix: string;
    private readonly nameByCanonical = new Map<string, string>();

    constructor(target: Record<string, unknown>, refPrefix: string) {
        this.target = target;
        this.refPrefix = refPrefix;
    }

    hoist(node: unknown, ownerScope: string): Record<string, unknown> {
        return this.transform(node, ownerScope, new Map()) as Record<
            string,
            unknown
        >;
    }

    private transform(
        node: unknown,
        ownerScope: string,
        activeScope: ReadonlyMap<string, string>,
    ): unknown {
        if (node === null || typeof node !== "object") return node;
        if (Array.isArray(node)) {
            return node.map((item) =>
                this.transform(item, ownerScope, activeScope),
            );
        }

        const record = node as Record<string, unknown>;
        let nextScope = activeScope;

        if (
            record.$defs &&
            typeof record.$defs === "object" &&
            !Array.isArray(record.$defs)
        ) {
            const localDefs = record.$defs as Record<string, unknown>;
            const scoped = new Map(activeScope);
            const allocated = new Map<string, string>();

            for (const defKey of Object.keys(localDefs)) {
                const preferred = this.preferredName(defKey, ownerScope);
                const reserved = this.reserveName(
                    defKey,
                    preferred,
                    ownerScope,
                );
                scoped.set(defKey, reserved);
                allocated.set(defKey, reserved);
            }

            const activeBodies = new Map<string, unknown>();
            for (const [defKey, defValue] of Object.entries(localDefs)) {
                activeBodies.set(
                    defKey,
                    this.transform(defValue, ownerScope, scoped),
                );
            }

            const finalScope = new Map(scoped);
            let changed = true;
            while (changed) {
                changed = false;
                const redirects = new Map<string, string>();
                for (const [defKey, allocatedName] of allocated.entries()) {
                    const currentName = finalScope.get(defKey);
                    if (!currentName || currentName !== allocatedName) continue;
                    const sig = canonicalJson(activeBodies.get(defKey));
                    const existing = this.nameByCanonical.get(sig);
                    if (existing && existing !== currentName) {
                        finalScope.set(defKey, existing);
                        redirects.set(
                            `${this.refPrefix}${currentName}`,
                            `${this.refPrefix}${existing}`,
                        );
                        changed = true;
                    }
                }
                if (redirects.size > 0) {
                    for (const [defKey, body] of activeBodies.entries()) {
                        activeBodies.set(
                            defKey,
                            this.rewriteExactRefs(body, redirects),
                        );
                    }
                }
            }

            for (const [defKey, allocatedName] of allocated.entries()) {
                if (finalScope.get(defKey) === allocatedName) {
                    const body = activeBodies.get(defKey);
                    this.target[allocatedName] = body;
                    this.nameByCanonical.set(
                        canonicalJson(body),
                        allocatedName,
                    );
                }
            }

            nextScope = finalScope;
        }

        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) {
            if (key === "$schema" || key === "$id" || key === "$defs") continue;
            if (
                key === "$ref" &&
                typeof value === "string" &&
                value.startsWith("#/$defs/")
            ) {
                const refKey = value.slice("#/$defs/".length);
                const mapped = nextScope.get(refKey);
                out.$ref = mapped ? `${this.refPrefix}${mapped}` : value;
                continue;
            }
            out[key] = this.transform(value, ownerScope, nextScope);
        }
        return out;
    }

    private preferredName(defKey: string, ownerScope: string): string {
        if (defKey.startsWith("__")) {
            return `${ownerScope}_${defKey.replace(/^_+/, "")}`;
        }
        return (defKey[0]?.toUpperCase() ?? "") + defKey.slice(1);
    }

    private reserveName(
        defKey: string,
        preferred: string,
        ownerScope: string,
    ): string {
        if (!(preferred in this.target)) return preferred;
        const candidate = `${ownerScope}_${defKey}`;
        if (!(candidate in this.target)) return candidate;
        let index = 2;
        while (`${candidate}_${index}` in this.target) index += 1;
        return `${candidate}_${index}`;
    }

    private rewriteExactRefs(
        node: unknown,
        replacements: ReadonlyMap<string, string>,
    ): unknown {
        if (node === null || typeof node !== "object") return node;
        if (Array.isArray(node)) {
            return node.map((item) =>
                this.rewriteExactRefs(item, replacements),
            );
        }
        const record = node as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) {
            if (
                key === "$ref" &&
                typeof value === "string" &&
                replacements.has(value)
            ) {
                out.$ref = replacements.get(value);
            } else {
                out[key] = this.rewriteExactRefs(value, replacements);
            }
        }
        return out;
    }
}

function toRawJsonSchema(
    schema: z.ZodType,
    io: "input" | "output",
): Record<string, unknown> {
    return z.toJSONSchema(schema, {
        io,
        target: "draft-2020-12",
        unrepresentable: "throw",
    }) as Record<string, unknown>;
}

function buildSharedSchemas(hoister: DefsHoister): Record<string, unknown> {
    const runCostSchema = z.strictObject({
        currency: z.literal("USD").describe("费用货币单位，固定为 USD。"),
        amount: z
            .number()
            .nonnegative()
            .describe(
                "已知累计费用（美元）。当 complete 为 false 时仅为已观测到的下限，不代表免费。",
            ),
        source: z
            .enum(["provider", "estimate", "mixed"])
            .describe("费用来源：供应商账单、本地估算或二者混合。"),
        complete: z
            .boolean()
            .describe(
                "本次运行所有计费调用是否均已获取费用；false 表示存在未知费用项。",
            ),
    });

    const validationDetailSchema = z.strictObject({
        path: z
            .string()
            .describe(
                "JSON Pointer 风格的失败字段路径（如 /sourceImageUrl 或 /headers/idempotency-key）。",
            ),
        keyword: z
            .string()
            .describe(
                "校验规则关键字（如 required、type、enum、maxLength、custom）。",
            ),
        message: z
            .string()
            .describe("脱敏后的字段级错误说明（已剥离 URL 查询参数与凭证）。"),
    });

    const processErrorCodeSchema = z
        .enum([
            "AGENT_FAILURE",
            "DEPENDENCY_FAILURE",
            "DEPENDENCY_FAILURE_AFTER_COMMIT",
            "INTERNAL_ERROR",
            "INVALID_INPUT",
            "INVALID_OUTPUT",
            "MASTER_BUDGET_EXHAUSTED",
            "MASTER_NOT_ACCEPTED",
            "PROCESS_NOT_FOUND",
            "PROCESS_TIMEOUT",
            "SOURCE_RUN_NOT_FOUND",
            "SOURCE_RUN_FORBIDDEN",
            "SOURCE_RUN_INVALID_PROCESS",
            "SOURCE_RUN_NOT_READY",
            "SOURCE_RUN_EXPIRED",
            "SOURCE_RUN_MISSING_CONDITION",
        ])
        .describe("Business Process 执行与受理阶段返回的稳定公开错误码。");

    const transportErrorCodeSchema = z
        .enum([
            "CALLER_UNAUTHORIZED",
            "CALLER_AUTH_UNAVAILABLE",
            "ROUTE_NOT_FOUND",
            "UNSUPPORTED_MEDIA_TYPE",
            "REQUEST_TOO_LARGE",
            "SERVICE_BUSY",
            "IDEMPOTENCY_KEY_REQUIRED",
            "INVALID_IDEMPOTENCY_KEY",
            "IDEMPOTENCY_CONFLICT",
            "CALLER_BACKLOG_LIMIT_REACHED",
            "ASYNC_SERVICE_CAPACITY_REACHED",
            "ASYNC_INTAKE_CLOSED",
            "ASYNC_SERVICE_UNAVAILABLE",
            "PROCESS_RUN_NOT_FOUND",
            "AGENT_NOT_FOUND",
            "AGENT_BACKLOG_LIMIT_REACHED",
            "CALLER_AGENT_BACKLOG_LIMIT_REACHED",
            "CONVERSATION_BUSY",
            "CONVERSATION_NOT_FOUND",
            "CONVERSATION_SEQUENCE_CONFLICT",
            "CONVERSATION_TURN_LIMIT_REACHED",
            "INVALID_QUERY",
            "AGENT_CONVERSATIONS_UNAVAILABLE",
        ])
        .describe("HTTP 传输、鉴权、容量与异步状态机返回的稳定公开错误码。");

    const agentTextBlockSchema = z.strictObject({
        type: z.literal("text"),
        text: z
            .string()
            .min(1)
            .max(12_000)
            .describe("trim 后长度为 1–12000 字符的文本块。"),
    });

    const agentImageBlockSchema = z.strictObject({
        type: z.literal("image"),
        resourceId: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)
            .describe(
                "部署方 owned resource service 中属于当前 caller 的稳定图片资源标识。",
            ),
    });

    const agentTurnInputSchema = z.strictObject({
        content: z
            .array(
                z.discriminatedUnion("type", [
                    agentTextBlockSchema,
                    agentImageBlockSchema,
                ]),
            )
            .min(1)
            .max(16)
            .describe(
                "按原顺序处理的 1–16 个文本或图片引用块（默认每轮最多 4 张图片）。",
            ),
    });

    const templateDiagnosticStepSchema = z.strictObject({
        scope: z.literal("main"),
        activity: z.enum([
            "template_image_loading",
            "template_compilation",
            "template_correction",
            "template_review",
            "template_review_correction",
            "template_validation",
        ]),
        status: z.enum(["succeeded", "failed", "cancelled"]),
        durationMs: z.int().nonnegative(),
        diagnostic: z
            .strictObject({
                stage: z.string(),
                code: z.string(),
                issues: z
                    .array(
                        z.strictObject({
                            path: z.string(),
                            code: z.string(),
                        }),
                    )
                    .max(8)
                    .optional(),
            })
            .optional(),
    });

    const templateDiagnosticsResponseSchema = z.strictObject({
        runId: z.string(),
        process: z.literal("template-from-image"),
        version: z.string(),
        steps: z.array(templateDiagnosticStepSchema),
    });

    const webhookEventSchema = z.strictObject({
        schemaVersion: z.literal(1),
        eventId: z
            .string()
            .describe("不可变事件标识，同一次事件重试时与 webhook-id 头一致。"),
        type: z.enum(["process_run.succeeded", "process_run.failed"]),
        createdAt: z.string().describe("ISO 8601 UTC 时间戳。"),
        data: z.strictObject({
            runId: z.string(),
            process: z.string(),
            version: z.string(),
            status: z.enum(["succeeded", "failed"]),
            resultLocation: z
                .string()
                .describe(
                    "权威结果查询相对路径（如 /process-runs/{runId}）；Webhook 本身不携带业务输出。",
                ),
        }),
    });

    return {
        RunCost: hoister.hoist(
            toRawJsonSchema(runCostSchema, "output"),
            "RunCost",
        ),
        InputValidationDetail: hoister.hoist(
            toRawJsonSchema(validationDetailSchema, "output"),
            "InputValidationDetail",
        ),
        ProcessErrorCode: hoister.hoist(
            toRawJsonSchema(processErrorCodeSchema, "output"),
            "ProcessErrorCode",
        ),
        TransportErrorCode: hoister.hoist(
            toRawJsonSchema(transportErrorCodeSchema, "output"),
            "TransportErrorCode",
        ),
        PublicError: {
            type: "object",
            required: ["code", "message"],
            additionalProperties: false,
            properties: {
                code: {
                    anyOf: [
                        { $ref: "#/components/schemas/ProcessErrorCode" },
                        { $ref: "#/components/schemas/TransportErrorCode" },
                    ],
                },
                message: {
                    type: "string",
                    description:
                        "经服务端净化的公开错误说明，不包含内部堆栈、上游凭证或签名参数。",
                },
                details: {
                    type: "array",
                    items: {
                        $ref: "#/components/schemas/InputValidationDetail",
                    },
                    description:
                        "仅在 400 入参或上游引用拒收时返回的字段级错误详情（最多 20 条）。",
                },
            },
        },
        TransportFailureResponse: {
            type: "object",
            required: ["status", "error"],
            additionalProperties: false,
            properties: {
                status: { type: "string", const: "failed" },
                error: { $ref: "#/components/schemas/PublicError" },
            },
        },
        ExecuteFailureResponse: {
            type: "object",
            required: ["runId", "status", "error"],
            additionalProperties: false,
            properties: {
                runId: { type: "string" },
                process: { type: "string" },
                version: { type: "string" },
                status: { type: "string", const: "failed" },
                error: { $ref: "#/components/schemas/PublicError" },
                cost: { $ref: "#/components/schemas/RunCost" },
                diagnostics: {
                    $ref: "#/components/schemas/TemplateDiagnosticsResponse",
                    description:
                        "仅在请求头携带 X-Pipipi-Template-Steps: 1 且调用 template-from-image 时附带。",
                },
            },
        },
        ProcessRunAcceptedResponse: {
            type: "object",
            required: ["runId", "process", "version", "status", "createdAt"],
            additionalProperties: false,
            properties: {
                runId: { type: "string" },
                process: { type: "string" },
                version: { type: "string" },
                status: {
                    type: "string",
                    enum: ["queued", "running", "succeeded", "failed"],
                    description:
                        "首次受理为 queued；幂等重放时返回既有 Run 的当前真实状态。",
                },
                createdAt: { type: "string", format: "date-time" },
            },
        },
        ProcessRunQueuedView: {
            type: "object",
            required: ["runId", "process", "version", "status", "createdAt"],
            additionalProperties: false,
            properties: {
                runId: { type: "string" },
                process: { type: "string" },
                version: { type: "string" },
                status: { type: "string", const: "queued" },
                createdAt: { type: "string", format: "date-time" },
            },
        },
        ProcessRunRunningView: {
            type: "object",
            required: [
                "runId",
                "process",
                "version",
                "status",
                "createdAt",
                "startedAt",
            ],
            additionalProperties: false,
            properties: {
                runId: { type: "string" },
                process: { type: "string" },
                version: { type: "string" },
                status: { type: "string", const: "running" },
                createdAt: { type: "string", format: "date-time" },
                startedAt: { type: "string", format: "date-time" },
            },
        },
        ProcessRunSucceededView: {
            type: "object",
            required: [
                "runId",
                "process",
                "version",
                "status",
                "createdAt",
                "startedAt",
                "finishedAt",
                "output",
            ],
            additionalProperties: false,
            properties: {
                runId: { type: "string" },
                process: { type: "string" },
                version: { type: "string" },
                status: { type: "string", const: "succeeded" },
                createdAt: { type: "string", format: "date-time" },
                startedAt: { type: "string", format: "date-time" },
                finishedAt: { type: "string", format: "date-time" },
                cost: { $ref: "#/components/schemas/RunCost" },
                output: {
                    description:
                        "对应 (process, version) 的精确输出对象，结构见各 *Output 组件 Schema。",
                },
            },
        },
        ProcessRunSucceededExpiredView: {
            type: "object",
            required: [
                "runId",
                "process",
                "version",
                "status",
                "createdAt",
                "startedAt",
                "finishedAt",
                "resultAvailability",
                "resultExpiredAt",
            ],
            additionalProperties: false,
            properties: {
                runId: { type: "string" },
                process: { type: "string" },
                version: { type: "string" },
                status: { type: "string", const: "succeeded" },
                createdAt: { type: "string", format: "date-time" },
                startedAt: { type: "string", format: "date-time" },
                finishedAt: { type: "string", format: "date-time" },
                cost: { $ref: "#/components/schemas/RunCost" },
                resultAvailability: { type: "string", const: "expired" },
                resultExpiredAt: { type: "string", format: "date-time" },
            },
        },
        ProcessRunFailedView: {
            type: "object",
            required: [
                "runId",
                "process",
                "version",
                "status",
                "createdAt",
                "startedAt",
                "finishedAt",
                "error",
            ],
            additionalProperties: false,
            properties: {
                runId: { type: "string" },
                process: { type: "string" },
                version: { type: "string" },
                status: { type: "string", const: "failed" },
                createdAt: { type: "string", format: "date-time" },
                startedAt: { type: "string", format: "date-time" },
                finishedAt: { type: "string", format: "date-time" },
                cost: { $ref: "#/components/schemas/RunCost" },
                error: { $ref: "#/components/schemas/PublicError" },
            },
        },
        ProcessRunFailedExpiredView: {
            type: "object",
            required: [
                "runId",
                "process",
                "version",
                "status",
                "createdAt",
                "startedAt",
                "finishedAt",
                "resultAvailability",
                "resultExpiredAt",
            ],
            additionalProperties: false,
            properties: {
                runId: { type: "string" },
                process: { type: "string" },
                version: { type: "string" },
                status: { type: "string", const: "failed" },
                createdAt: { type: "string", format: "date-time" },
                startedAt: { type: "string", format: "date-time" },
                finishedAt: { type: "string", format: "date-time" },
                cost: { $ref: "#/components/schemas/RunCost" },
                resultAvailability: { type: "string", const: "expired" },
                resultExpiredAt: { type: "string", format: "date-time" },
            },
        },
        ProcessRunView: {
            oneOf: [
                { $ref: "#/components/schemas/ProcessRunQueuedView" },
                { $ref: "#/components/schemas/ProcessRunRunningView" },
                { $ref: "#/components/schemas/ProcessRunSucceededView" },
                { $ref: "#/components/schemas/ProcessRunSucceededExpiredView" },
                { $ref: "#/components/schemas/ProcessRunFailedView" },
                { $ref: "#/components/schemas/ProcessRunFailedExpiredView" },
            ],
        },
        AgentTurnInput: hoister.hoist(
            toRawJsonSchema(agentTurnInputSchema, "input"),
            "AgentTurnInput",
        ),
        OpenAgentConversationRequest: {
            type: "object",
            required: ["agent", "input"],
            additionalProperties: false,
            properties: {
                agent: {
                    type: "object",
                    required: ["id", "version"],
                    additionalProperties: false,
                    properties: {
                        id: { type: "string", minLength: 1 },
                        version: { type: "string", minLength: 1 },
                    },
                },
                input: { $ref: "#/components/schemas/AgentTurnInput" },
            },
        },
        ContinueAgentConversationRequest: {
            type: "object",
            required: ["afterTurnId", "input"],
            additionalProperties: false,
            properties: {
                afterTurnId: {
                    type: "string",
                    minLength: 1,
                    maxLength: 256,
                    description:
                        "上一轮已受理的 turnId，用于保证单活跃 Turn 与顺序一致性。",
                },
                input: { $ref: "#/components/schemas/AgentTurnInput" },
            },
        },
        AgentConversationAcceptedResponse: {
            type: "object",
            required: [
                "conversationId",
                "turnId",
                "sequence",
                "status",
                "createdAt",
            ],
            additionalProperties: false,
            properties: {
                conversationId: { type: "string" },
                turnId: { type: "string" },
                sequence: { type: "integer", minimum: 1 },
                status: {
                    type: "string",
                    enum: ["queued", "running", "succeeded", "failed"],
                },
                createdAt: { type: "string", format: "date-time" },
            },
        },
        AgentTurnView: {
            type: "object",
            required: ["turnId", "sequence", "status", "input", "createdAt"],
            properties: {
                turnId: { type: "string" },
                sequence: { type: "integer", minimum: 1 },
                status: {
                    type: "string",
                    enum: ["queued", "running", "succeeded", "failed"],
                },
                input: { type: "object" },
                output: { type: "object" },
                error: { $ref: "#/components/schemas/PublicError" },
                createdAt: { type: "string", format: "date-time" },
                startedAt: { type: "string", format: "date-time" },
                finishedAt: { type: "string", format: "date-time" },
            },
        },
        AgentConversationView: {
            type: "object",
            required: [
                "conversationId",
                "agent",
                "configRevision",
                "status",
                "turnCount",
                "lastTurnId",
                "createdAt",
                "updatedAt",
                "expiresAt",
                "turns",
            ],
            additionalProperties: false,
            properties: {
                conversationId: { type: "string" },
                agent: {
                    type: "object",
                    required: ["id", "version"],
                    additionalProperties: false,
                    properties: {
                        id: { type: "string" },
                        version: { type: "string" },
                    },
                },
                configRevision: {
                    type: "string",
                    description:
                        "绑定到该 Conversation 的服务端行为配置 SHA-256 标识。",
                },
                status: { type: "string", enum: ["busy", "ready"] },
                turnCount: { type: "integer", minimum: 1 },
                lastTurnId: { type: "string" },
                createdAt: { type: "string", format: "date-time" },
                updatedAt: { type: "string", format: "date-time" },
                expiresAt: { type: "string", format: "date-time" },
                turns: {
                    type: "array",
                    items: { $ref: "#/components/schemas/AgentTurnView" },
                },
                nextCursor: { type: "string" },
            },
        },
        AgentConversationDeletionResponse: {
            type: "object",
            required: ["conversationId", "status", "deleteBy"],
            additionalProperties: false,
            properties: {
                conversationId: { type: "string" },
                status: { type: "string", const: "deletion_accepted" },
                deleteBy: { type: "string", format: "date-time" },
            },
        },
        TemplateDiagnosticsResponse: hoister.hoist(
            toRawJsonSchema(templateDiagnosticsResponseSchema, "output"),
            "TemplateDiagnosticsResponse",
        ),
        WebhookProcessRunEvent: hoister.hoist(
            toRawJsonSchema(webhookEventSchema, "output"),
            "WebhookProcessRunEvent",
        ),
    };
}

/** 构造单个 Business Process 版本的轻量化自包含契约切片（供调用 Agent 按需读取）。 */
export function buildProcessOpenApiSlice(
    registration: ProcessRegistration,
    defaultProcessTimeoutMs = defaultTimeoutMsFallback,
): Record<string, unknown> {
    const { id, version } = registration.identity;
    const prefix = openApiComponentPrefix(id, version);
    const localDefs: Record<string, unknown> = {};
    const hoister = new DefsHoister(localDefs, "#/$defs/");
    const inputSchema = hoister.hoist(
        toRawJsonSchema(registration.inputSchema, "input"),
        `${prefix}Input`,
    );
    const outputSchema = hoister.hoist(
        toRawJsonSchema(registration.outputSchema, "output"),
        `${prefix}Output`,
    );
    const timeoutMs = registration.timeoutMs ?? defaultProcessTimeoutMs;

    return {
        process: id,
        version,
        timeoutMs,
        retry: {
            maximumAttempts: registration.retryPolicy.maximumAttempts,
            retryableErrorCodes: [
                ...registration.retryPolicy.retryableErrorCodes,
            ],
        },
        jsonSchemaDialect,
        ...(Object.keys(localDefs).length > 0 ? { $defs: localDefs } : {}),
        requestSchema: {
            type: "object",
            required: ["process", "version", "input"],
            additionalProperties: false,
            properties: {
                process: { type: "string", const: id },
                version: { type: "string", const: version },
                input: inputSchema,
            },
        },
        inputSchema,
        outputSchema,
        successResponseSchema: {
            type: "object",
            required: ["runId", "process", "version", "status", "output"],
            additionalProperties: false,
            properties: {
                runId: { type: "string" },
                process: { type: "string", const: id },
                version: { type: "string", const: version },
                status: { type: "string", const: "succeeded" },
                output: outputSchema,
                cost: {
                    type: "object",
                    required: ["currency", "amount", "source", "complete"],
                    additionalProperties: false,
                    properties: {
                        currency: { type: "string", const: "USD" },
                        amount: { type: "number", minimum: 0 },
                        source: {
                            type: "string",
                            enum: ["provider", "estimate", "mixed"],
                        },
                        complete: { type: "boolean" },
                    },
                },
            },
        },
    };
}

/** 从 ProcessRegistry 构造完整 OpenAPI 3.1.0 公开契约文档，不暴露内部 Skill、活动或运行配置。 */
export function buildOpenApiDocument(
    registry: ProcessRegistry,
    options: OpenApiOptions = {},
): Record<string, unknown> {
    const defaultTimeoutMs =
        options.defaultProcessTimeoutMs ?? defaultTimeoutMsFallback;
    const serverUrl = options.serverUrl ?? defaultServerUrl;
    const registrations = registry.list();
    const schemas: Record<string, unknown> = {};
    const hoister = new DefsHoister(schemas, "#/components/schemas/");

    Object.assign(schemas, buildSharedSchemas(hoister));

    const executeRequestRefs: Array<Record<string, unknown>> = [];
    const executeSuccessRefs: Array<Record<string, unknown>> = [];
    const processIndex: Array<Record<string, unknown>> = [];

    for (const registration of registrations) {
        const { id, version } = registration.identity;
        const prefix = openApiComponentPrefix(id, version);
        const inputName = `${prefix}Input`;
        const outputName = `${prefix}Output`;
        const requestName = `Execute${prefix}Request`;
        const responseName = `Execute${prefix}SuccessResponse`;
        const timeoutMs = registration.timeoutMs ?? defaultTimeoutMs;

        schemas[inputName] = hoister.hoist(
            toRawJsonSchema(registration.inputSchema, "input"),
            inputName,
        );
        schemas[outputName] = hoister.hoist(
            toRawJsonSchema(registration.outputSchema, "output"),
            outputName,
        );

        schemas[requestName] = {
            title: `${id}/${version} Request`,
            type: "object",
            required: ["process", "version", "input"],
            additionalProperties: false,
            "x-pipipi-process": id,
            "x-pipipi-version": version,
            "x-pipipi-timeout-ms": timeoutMs,
            "x-pipipi-retry": {
                maximumAttempts: registration.retryPolicy.maximumAttempts,
                retryableErrorCodes: [
                    ...registration.retryPolicy.retryableErrorCodes,
                ],
            },
            properties: {
                process: { type: "string", const: id },
                version: { type: "string", const: version },
                input: { $ref: `#/components/schemas/${inputName}` },
            },
        };

        schemas[responseName] = {
            title: `${id}/${version} Success Response`,
            type: "object",
            required: ["runId", "process", "version", "status", "output"],
            additionalProperties: false,
            properties: {
                runId: { type: "string" },
                process: { type: "string", const: id },
                version: { type: "string", const: version },
                status: { type: "string", const: "succeeded" },
                output: { $ref: `#/components/schemas/${outputName}` },
                cost: { $ref: "#/components/schemas/RunCost" },
                ...(id === "template-from-image"
                    ? {
                          diagnostics: {
                              $ref: "#/components/schemas/TemplateDiagnosticsResponse",
                          },
                      }
                    : {}),
            },
        };

        executeRequestRefs.push({
            $ref: `#/components/schemas/${requestName}`,
        });
        executeSuccessRefs.push({
            $ref: `#/components/schemas/${responseName}`,
        });
        processIndex.push({
            process: id,
            version,
            timeoutMs,
            maximumAttempts: registration.retryPolicy.maximumAttempts,
            retryableErrorCodes: [
                ...registration.retryPolicy.retryableErrorCodes,
            ],
            slicePath: `/openapi/processes/${id}/${version}.json`,
            requestRef: `#/components/schemas/${requestName}`,
            inputRef: `#/components/schemas/${inputName}`,
            outputRef: `#/components/schemas/${outputName}`,
        });
    }

    schemas.ExecuteProcessRequest = {
        description:
            "按精确 (process, version) 分发的业务流程请求信封。请求体不得携带模型、Skill、Tool、Prompt 或执行步骤。",
        oneOf: executeRequestRefs,
    };

    schemas.ExecuteProcessSuccessResponse = {
        description:
            "同步执行成功响应；output 结构由对应的 (process, version) 决定。",
        oneOf: executeSuccessRefs,
    };

    const jsonError = (
        description: string,
        schemaRef = "#/components/schemas/TransportFailureResponse",
    ) => ({
        description,
        content: {
            "application/json": {
                schema: { $ref: schemaRef },
            },
        },
    });

    const webhookHeaders = {
        "webhook-id": {
            description:
                "事件唯一 ID（与 payload.eventId 一致），重试时保持不变。",
            required: true,
            schema: { type: "string" },
        },
        "webhook-timestamp": {
            description: "签名时的 Unix 秒时间戳。",
            required: true,
            schema: { type: "string" },
        },
        "webhook-signature": {
            description:
                "一个或两个空格分隔的 Standard Webhooks 签名（v1,<base64-hmac>）。",
            required: true,
            schema: { type: "string" },
        },
    };

    const webhookOperation = (
        eventType: "process_run.succeeded" | "process_run.failed",
    ) => ({
        post: {
            summary: `异步 Process Run 终态通知：${eventType}`,
            description:
                "采用 Standard Webhooks 签名与至少一次投递。仅通知终态，不携带业务输入、输出或内部错误；请使用 owner 凭证读取 data.resultLocation。",
            parameters: Object.entries(webhookHeaders).map(([name, spec]) => ({
                name,
                in: "header",
                ...spec,
            })),
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: {
                            $ref: "#/components/schemas/WebhookProcessRunEvent",
                        },
                    },
                },
            },
            responses: {
                "200": {
                    description:
                        "接收方已可靠持久化事件（按 eventId 幂等处理）。",
                },
            },
        },
    });

    return {
        openapi: "3.1.0",
        jsonSchemaDialect,
        info: {
            title: "Pipipi Business Process API",
            version: options.version ?? "0.1.0",
            summary:
                "版本化 Business Process 执行与 Agent Conversations 公开契约",
            description:
                "由服务端 ProcessRegistry 与 Zod Schema 在启动时自动派生的公开 HTTP 契约。认证规则、付费副作用、重试红线、Webhook 验签与业务边界请阅读 /docs/api.md；单 Process 轻量化 Schema 可按 /openapi/processes/{process}/{version}.json 按需读取；Agent 导航请从 /llms.txt 进入。",
        },
        externalDocs: {
            description:
                "业务接口指南（认证、重试红线、Webhook 验签与调用示例）",
            url: `${serverUrl}/docs/api.md`,
        },
        servers: [
            {
                url: serverUrl,
                description: "Production API",
            },
        ],
        tags: [
            {
                name: "Process Execution (Sync)",
                description: "同步单请求执行 Business Process（不提供幂等）。",
            },
            {
                name: "Process Runs (Async)",
                description:
                    "带 caller-scoped Idempotency-Key 的异步受理与轮询。",
            },
            {
                name: "Agent Conversations",
                description:
                    "多轮交互式 Agent 会话（需 AGENT_CONVERSATIONS_ENABLED=true 且已登记生产 Agent）。",
            },
            {
                name: "Template Diagnostics",
                description: "Memebuy 模板制作工作台只读步骤诊断。",
            },
        ],
        "x-pipipi-processes": processIndex,
        paths: {
            "/execute": {
                post: {
                    operationId: "executeProcess",
                    tags: ["Process Execution (Sync)"],
                    summary: "同步执行指定版本的 Business Process",
                    description:
                        "在单个 HTTP 请求内同步执行精确版本化的 Business Process 并返回终态。同步入口不提供幂等保证；付费图片类 Process 遇到超时或模糊依赖失败时严禁自动重试。详细语义与重试决策见 /docs/api.md。",
                    security: [{ BearerAuth: [] }, {}],
                    parameters: [
                        { $ref: "#/components/parameters/XRequestId" },
                        { $ref: "#/components/parameters/XTemplateSteps" },
                    ],
                    requestBody: {
                        required: true,
                        content: {
                            "application/json": {
                                schema: {
                                    $ref: "#/components/schemas/ExecuteProcessRequest",
                                },
                            },
                        },
                    },
                    responses: {
                        "200": {
                            description:
                                '执行成功（调用方须同时检查 HTTP 2xx 与 status === "succeeded"）。',
                            content: {
                                "application/json": {
                                    schema: {
                                        $ref: "#/components/schemas/ExecuteProcessSuccessResponse",
                                    },
                                },
                            },
                        },
                        "400": jsonError(
                            "入参校验失败（INVALID_INPUT）或上游运行引用非法（SOURCE_RUN_*），包含字段级 error.details。",
                            "#/components/schemas/ExecuteFailureResponse",
                        ),
                        "401": jsonError(
                            "调用方身份校验失败（仅在 EXECUTE_AUTH_MODE=required 时返回 CALLER_UNAUTHORIZED）。",
                        ),
                        "404": jsonError(
                            "未找到精确匹配的 (process, version)（PROCESS_NOT_FOUND）。",
                            "#/components/schemas/ExecuteFailureResponse",
                        ),
                        "413": jsonError(
                            "请求体超过 256 KiB 上限（REQUEST_TOO_LARGE）。",
                        ),
                        "415": jsonError(
                            "Content-Type 非 application/json（UNSUPPORTED_MEDIA_TYPE）。",
                        ),
                        "500": jsonError(
                            "内部异常或输出契约校验失败（INTERNAL_ERROR / INVALID_OUTPUT）。",
                            "#/components/schemas/ExecuteFailureResponse",
                        ),
                        "502": jsonError(
                            "Agent 失败、下游依赖失败或母版预算耗尽（AGENT_FAILURE / DEPENDENCY_FAILURE / DEPENDENCY_FAILURE_AFTER_COMMIT / MASTER_*）。",
                            "#/components/schemas/ExecuteFailureResponse",
                        ),
                        "503": {
                            description:
                                "同步并发容量已满（SERVICE_BUSY，附带 Retry-After）或认证存储暂不可用（CALLER_AUTH_UNAVAILABLE）。",
                            headers: {
                                "Retry-After": {
                                    $ref: "#/components/headers/RetryAfter",
                                },
                            },
                            content: {
                                "application/json": {
                                    schema: {
                                        $ref: "#/components/schemas/TransportFailureResponse",
                                    },
                                },
                            },
                        },
                        "504": jsonError(
                            "超过服务端单次执行时限（PROCESS_TIMEOUT）。付费流程不得盲目重试。",
                            "#/components/schemas/ExecuteFailureResponse",
                        ),
                    },
                },
            },
            "/process-runs": {
                post: {
                    operationId: "submitProcessRun",
                    tags: ["Process Runs (Async)"],
                    summary: "异步提交一个带幂等保障的 Business Process Run",
                    description:
                        "持久化受理业务流程并返回 runId 供轮询或接收 Webhook。要求调用方身份认证与稳定 caller-scoped Idempotency-Key；默认部署未开放时返回 404。",
                    "x-feature-flag": "ASYNC_PROCESS_RUNS_ENABLED",
                    security: [{ BearerAuth: [] }],
                    parameters: [
                        { $ref: "#/components/parameters/IdempotencyKey" },
                        { $ref: "#/components/parameters/XRequestId" },
                    ],
                    requestBody: {
                        required: true,
                        content: {
                            "application/json": {
                                schema: {
                                    $ref: "#/components/schemas/ExecuteProcessRequest",
                                },
                            },
                        },
                    },
                    responses: {
                        "202": {
                            description:
                                "已受理或按相同 Idempotency-Key 幂等重放。",
                            headers: {
                                Location: {
                                    description:
                                        "结果轮询路径（/process-runs/{runId}）。",
                                    schema: { type: "string" },
                                },
                                "Retry-After": {
                                    $ref: "#/components/headers/RetryAfter",
                                },
                            },
                            content: {
                                "application/json": {
                                    schema: {
                                        $ref: "#/components/schemas/ProcessRunAcceptedResponse",
                                    },
                                },
                            },
                        },
                        "400": jsonError(
                            "缺少/非法 Idempotency-Key、入参校验失败（INVALID_INPUT）或上游引用非法（SOURCE_RUN_*）。",
                        ),
                        "401": jsonError(
                            "调用方认证失败（CALLER_UNAUTHORIZED）。",
                        ),
                        "404": jsonError(
                            "异步入口未开启（ROUTE_NOT_FOUND）或 Process 不存在（PROCESS_NOT_FOUND）。",
                        ),
                        "409": jsonError(
                            "同一 caller 与 Idempotency-Key 提交了不同请求内容（IDEMPOTENCY_CONFLICT）。",
                        ),
                        "413": jsonError(
                            "请求体超过上限（REQUEST_TOO_LARGE）。",
                        ),
                        "415": jsonError(
                            "Content-Type 非 application/json（UNSUPPORTED_MEDIA_TYPE）。",
                        ),
                        "429": {
                            description:
                                "调用方待处理积压达到上限（CALLER_BACKLOG_LIMIT_REACHED），可用同一 Idempotency-Key 安全重试。",
                            headers: {
                                "Retry-After": {
                                    $ref: "#/components/headers/RetryAfter",
                                },
                            },
                            content: {
                                "application/json": {
                                    schema: {
                                        $ref: "#/components/schemas/TransportFailureResponse",
                                    },
                                },
                            },
                        },
                        "503": {
                            description:
                                "异步服务容量上限、停流或依赖暂不可用（ASYNC_SERVICE_CAPACITY_REACHED / ASYNC_INTAKE_CLOSED / ASYNC_SERVICE_UNAVAILABLE）。",
                            headers: {
                                "Retry-After": {
                                    $ref: "#/components/headers/RetryAfter",
                                },
                            },
                            content: {
                                "application/json": {
                                    schema: {
                                        $ref: "#/components/schemas/TransportFailureResponse",
                                    },
                                },
                            },
                        },
                    },
                },
            },
            "/process-runs/{runId}": {
                get: {
                    operationId: "getProcessRun",
                    tags: ["Process Runs (Async)"],
                    summary: "按 owner 隔离查询异步 Process Run 权威状态与结果",
                    "x-feature-flag": "ASYNC_PROCESS_RUNS_ENABLED",
                    security: [{ BearerAuth: [] }],
                    parameters: [
                        {
                            name: "runId",
                            in: "path",
                            required: true,
                            schema: { type: "string" },
                            description: "异步提交返回的 runId。",
                        },
                    ],
                    responses: {
                        "200": {
                            description:
                                "当前 Run 状态；非终态时附带 Retry-After 提示轮询间隔。",
                            headers: {
                                "Retry-After": {
                                    $ref: "#/components/headers/RetryAfter",
                                },
                            },
                            content: {
                                "application/json": {
                                    schema: {
                                        $ref: "#/components/schemas/ProcessRunView",
                                    },
                                },
                            },
                        },
                        "401": jsonError(
                            "调用方认证失败（CALLER_UNAUTHORIZED）。",
                        ),
                        "404": jsonError(
                            "Run 不存在或不属于当前 caller（PROCESS_RUN_NOT_FOUND）。",
                        ),
                        "503": jsonError(
                            "异步查询依赖暂不可用（ASYNC_SERVICE_UNAVAILABLE）。",
                        ),
                    },
                },
            },
            "/agent-conversations": {
                post: {
                    operationId: "openAgentConversation",
                    tags: ["Agent Conversations"],
                    summary: "创建多轮 Agent Conversation 并提交首轮 Turn",
                    description:
                        "由 AGENT_CONVERSATIONS_ENABLED 门禁控制（当前生产 Agent catalog 为空，未登记生产 Agent 前不可开启）。",
                    "x-feature-flag": "AGENT_CONVERSATIONS_ENABLED",
                    security: [{ BearerAuth: [] }],
                    parameters: [
                        { $ref: "#/components/parameters/IdempotencyKey" },
                    ],
                    requestBody: {
                        required: true,
                        content: {
                            "application/json": {
                                schema: {
                                    $ref: "#/components/schemas/OpenAgentConversationRequest",
                                },
                            },
                        },
                    },
                    responses: {
                        "202": {
                            description: "首轮 Turn 已受理。",
                            headers: {
                                Location: { schema: { type: "string" } },
                                "Retry-After": {
                                    $ref: "#/components/headers/RetryAfter",
                                },
                            },
                            content: {
                                "application/json": {
                                    schema: {
                                        $ref: "#/components/schemas/AgentConversationAcceptedResponse",
                                    },
                                },
                            },
                        },
                        "400": jsonError("入参或 Idempotency-Key 非法。"),
                        "401": jsonError("调用方认证失败。"),
                        "404": jsonError("Agent 不存在或功能未启用。"),
                        "409": jsonError(
                            "幂等键冲突（IDEMPOTENCY_CONFLICT）。",
                        ),
                        "429": jsonError("积压达到上限。"),
                        "503": jsonError("Agent Conversations 暂不可用。"),
                    },
                },
            },
            "/agent-conversations/{conversationId}/turns": {
                post: {
                    operationId: "continueAgentConversation",
                    tags: ["Agent Conversations"],
                    summary: "向既有 Conversation 追加下一轮 Turn",
                    "x-feature-flag": "AGENT_CONVERSATIONS_ENABLED",
                    security: [{ BearerAuth: [] }],
                    parameters: [
                        {
                            name: "conversationId",
                            in: "path",
                            required: true,
                            schema: { type: "string" },
                        },
                        { $ref: "#/components/parameters/IdempotencyKey" },
                    ],
                    requestBody: {
                        required: true,
                        content: {
                            "application/json": {
                                schema: {
                                    $ref: "#/components/schemas/ContinueAgentConversationRequest",
                                },
                            },
                        },
                    },
                    responses: {
                        "202": {
                            description: "追加 Turn 已受理。",
                            content: {
                                "application/json": {
                                    schema: {
                                        $ref: "#/components/schemas/AgentConversationAcceptedResponse",
                                    },
                                },
                            },
                        },
                        "400": jsonError("入参或 Idempotency-Key 非法。"),
                        "401": jsonError("调用方认证失败。"),
                        "404": jsonError(
                            "Conversation 不存在或不属于当前 caller。",
                        ),
                        "409": jsonError(
                            "存在活跃 Turn（CONVERSATION_BUSY）、顺序冲突（CONVERSATION_SEQUENCE_CONFLICT）、轮次达上限或幂等冲突。",
                        ),
                        "429": jsonError("积压达到上限。"),
                        "503": jsonError("Agent Conversations 暂不可用。"),
                    },
                },
            },
            "/agent-conversations/{conversationId}": {
                get: {
                    operationId: "getAgentConversation",
                    tags: ["Agent Conversations"],
                    summary: "按 owner 分页查询 Conversation 状态与历史 Turn",
                    "x-feature-flag": "AGENT_CONVERSATIONS_ENABLED",
                    security: [{ BearerAuth: [] }],
                    parameters: [
                        {
                            name: "conversationId",
                            in: "path",
                            required: true,
                            schema: { type: "string" },
                        },
                        {
                            name: "after",
                            in: "query",
                            required: false,
                            schema: { type: "string" },
                            description:
                                "上次返回的 opaque 分页游标（nextCursor）。",
                        },
                        {
                            name: "limit",
                            in: "query",
                            required: false,
                            schema: {
                                type: "integer",
                                minimum: 1,
                                maximum: 100,
                            },
                        },
                    ],
                    responses: {
                        "200": {
                            description:
                                "Conversation 公共状态与分页 Turn 列表。",
                            content: {
                                "application/json": {
                                    schema: {
                                        $ref: "#/components/schemas/AgentConversationView",
                                    },
                                },
                            },
                        },
                        "400": jsonError("分页查询参数非法（INVALID_QUERY）。"),
                        "401": jsonError("调用方认证失败。"),
                        "404": jsonError(
                            "Conversation 不存在或不属于当前 caller。",
                        ),
                        "503": jsonError("Agent Conversations 暂不可用。"),
                    },
                },
                delete: {
                    operationId: "deleteAgentConversation",
                    tags: ["Agent Conversations"],
                    summary: "删除 Conversation（立即 fencing 并排期物理清理）",
                    "x-feature-flag": "AGENT_CONVERSATIONS_ENABLED",
                    security: [{ BearerAuth: [] }],
                    parameters: [
                        {
                            name: "conversationId",
                            in: "path",
                            required: true,
                            schema: { type: "string" },
                        },
                    ],
                    responses: {
                        "202": {
                            description:
                                "删除已受理并返回最晚物理清理截止时间。",
                            content: {
                                "application/json": {
                                    schema: {
                                        $ref: "#/components/schemas/AgentConversationDeletionResponse",
                                    },
                                },
                            },
                        },
                        "401": jsonError("调用方认证失败。"),
                        "404": jsonError(
                            "Conversation 不存在或不属于当前 caller。",
                        ),
                        "503": jsonError("Agent Conversations 暂不可用。"),
                    },
                },
            },
            "/memebuy/template-runs/{runId}/diagnostics": {
                get: {
                    operationId: "getTemplateRunDiagnostics",
                    tags: ["Template Diagnostics"],
                    summary:
                        "查询保留期内 template-from-image 运行的脱敏执行步骤",
                    description:
                        "面向 Memebuy 后端的只读诊断接口，使用独立 Bearer 凭证（MEMEBUY_TEMPLATE_DIAGNOSTICS_TOKEN），仅返回 template-from-image 脱敏步骤。",
                    security: [{ TemplateDiagnosticsBearerAuth: [] }],
                    parameters: [
                        {
                            name: "runId",
                            in: "path",
                            required: true,
                            schema: { type: "string", format: "uuid" },
                        },
                    ],
                    responses: {
                        "200": {
                            description: "脱敏执行步骤列表。",
                            content: {
                                "application/json": {
                                    schema: {
                                        $ref: "#/components/schemas/TemplateDiagnosticsResponse",
                                    },
                                },
                            },
                        },
                        "401": { description: "凭证无效。" },
                        "404": {
                            description:
                                "未找到对应的 template-from-image 运行。",
                        },
                        "503": { description: "未配置活动归档或诊断凭证。" },
                    },
                },
            },
        },
        webhooks: {
            "process_run.succeeded": webhookOperation("process_run.succeeded"),
            "process_run.failed": webhookOperation("process_run.failed"),
        },
        components: {
            securitySchemes: {
                BearerAuth: {
                    type: "http",
                    scheme: "bearer",
                    bearerFormat: "ppk_...",
                    description:
                        "服务端发放的调用方 API Key（Authorization: Bearer <ppk_...>）。/execute 按 EXECUTE_AUTH_MODE（open/audit/required）生效；异步与会话接口始终要求认证。",
                },
                TemplateDiagnosticsBearerAuth: {
                    type: "http",
                    scheme: "bearer",
                    description:
                        "仅用于 /memebuy/template-runs/{runId}/diagnostics 的产品级只读凭证（MEMEBUY_TEMPLATE_DIAGNOSTICS_TOKEN）。",
                },
            },
            parameters: {
                IdempotencyKey: {
                    name: "Idempotency-Key",
                    in: "header",
                    required: true,
                    schema: { type: "string", minLength: 1, maxLength: 512 },
                    description:
                        "Caller 作用域稳定幂等键（UTF-8 不超过 512 字节）。",
                },
                XRequestId: {
                    name: "X-Request-Id",
                    in: "header",
                    required: false,
                    schema: {
                        type: "string",
                        pattern: "^[A-Za-z0-9_.:-]{1,200}$",
                    },
                    description:
                        "调用方链路追踪标识，仅用于日志排查，不提供幂等性。",
                },
                XTemplateSteps: {
                    name: "X-Pipipi-Template-Steps",
                    in: "header",
                    required: false,
                    schema: { type: "string", enum: ["1"] },
                    description:
                        "仅在调用 template-from-image 时设为 1 以在回执中附带脱敏 diagnostics 步骤。",
                },
            },
            headers: {
                RetryAfter: {
                    description: "建议客户端退避或下次轮询等待秒数。",
                    schema: { type: "integer", minimum: 1 },
                },
            },
            schemas,
        },
    };
}

/** 启动时从 ProcessRegistry 一次性生成并缓存不可变 UTF-8 OpenAPI JSON 与各 Process 单切片。 */
export function createOpenApiCatalog(
    registry: ProcessRegistry,
    options: OpenApiOptions = {},
): OpenApiCatalog {
    const defaultTimeoutMs =
        options.defaultProcessTimeoutMs ?? defaultTimeoutMsFallback;
    const document = Buffer.from(
        JSON.stringify(buildOpenApiDocument(registry, options)),
        "utf8",
    );
    const slices = new Map<string, Buffer>();
    for (const registration of registry.list()) {
        const key = `${registration.identity.id}/${registration.identity.version}`;
        slices.set(
            key,
            Buffer.from(
                JSON.stringify(
                    buildProcessOpenApiSlice(registration, defaultTimeoutMs),
                ),
                "utf8",
            ),
        );
    }

    return Object.freeze({
        document,
        processSlice: (process, version) => slices.get(`${process}/${version}`),
    });
}
