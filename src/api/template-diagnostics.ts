/** 为 Memebuy 模板执行回执与只读历史查询投影同一组脱敏父子步骤。 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, timingSafeEqual } from "node:crypto";
import { attemptReceiptSchema } from "../business-api/template-gateway-receipt.js";
import { sanitizeActivityDiagnostic } from "../process-runtime/diagnostics.js";
import type {
    ProcessRunLogRecord,
    ProcessRunResult,
} from "../process-runtime/index.js";

const activities = {
    "template-image-plan": [
        "source_loading",
        "replacement_planning",
        "plan_validation",
        "plan_correction",
        "plan_persistence",
    ],
    "template-image-render": ["approved_image_rendering"],
    "template-from-source": [
        "approved_image_upload",
        "approved_image_compilation",
    ],
    "template-from-image": [
        "template_image_loading",
        "template_compilation",
        "template_correction",
        "template_review",
        "template_review_correction",
        "template_validation",
    ],
} as const;
type TemplateProcess = keyof typeof activities;
function isTemplate(value: unknown): value is TemplateProcess {
    return typeof value === "string" && Object.hasOwn(activities, value);
}
function project(
    rows: readonly ProcessRunLogRecord[],
    runId: string,
    process: TemplateProcess,
    version: string,
    scope: "main" | "compile",
) {
    const allowed: readonly string[] = activities[process];
    return rows.flatMap((row) => {
        if (
            row.runId !== runId ||
            row.process !== process ||
            row.version !== version ||
            row.event !== "process_run_activity_finished" ||
            !allowed.includes(row.activity) ||
            !Number.isSafeInteger(row.durationMs) ||
            row.durationMs < 0
        )
            return [];
        const diagnostic = sanitizeActivityDiagnostic(row.diagnostic);
        return [
            {
                scope,
                activity: row.activity,
                status: row.outcome,
                durationMs: row.durationMs,
                ...(diagnostic
                    ? {
                          diagnostic: {
                              stage: diagnostic.stage,
                              code: diagnostic.code,
                              ...(diagnostic.stage === "schema" &&
                              diagnostic.code === "invalid_contract" &&
                              diagnostic.issues?.length
                                  ? { issues: diagnostic.issues }
                                  : {}),
                          },
                      }
                    : {}),
            },
        ];
    });
}
function timeline(
    runId: string,
    process: TemplateProcess,
    version: string,
    root: readonly ProcessRunLogRecord[],
    child: readonly ProcessRunLogRecord[],
) {
    return {
        runId,
        process,
        version,
        steps: [
            ...project(root, runId, process, version, "main"),
            ...(process === "template-from-source"
                ? project(
                      child,
                      `${runId}:compile`,
                      "template-from-image",
                      version,
                      "compile",
                  )
                : []),
        ],
    };
}

export function createTemplateDiagnostics(options: {
    secret?: string;
    inspectRender?: (runId: string) => Promise<unknown>;
    findByRun?: (id: string) => Promise<readonly ProcessRunLogRecord[]>;
}) {
    const storage = new AsyncLocalStorage<ProcessRunLogRecord[]>();
    const digest = (value: string) =>
        createHash("sha256").update(value).digest();
    if (options.secret && Buffer.byteLength(options.secret) < 32)
        throw new Error(
            "MEMEBUY_TEMPLATE_DIAGNOSTICS_TOKEN must be at least 32 bytes",
        );
    const expected = options.secret ? digest(`Bearer ${options.secret}`) : null;
    return {
        record(row: ProcessRunLogRecord) {
            const rows = storage.getStore();
            if (
                rows &&
                rows.length < 128 &&
                isTemplate(row.process) &&
                row.event === "process_run_activity_finished"
            )
                rows.push(row);
        },
        async execute(
            request: unknown,
            execute: (request: unknown) => Promise<ProcessRunResult>,
        ) {
            if (
                !request ||
                typeof request !== "object" ||
                !("process" in request) ||
                !isTemplate(request.process)
            )
                return execute(request);
            const rows: ProcessRunLogRecord[] = [];
            const result = await storage.run(rows, () => execute(request));
            if (!isTemplate(result.process) || !result.version) return result;
            const diagnostics = timeline(
                result.runId,
                result.process,
                result.version,
                rows,
                rows,
            );
            return diagnostics.steps.length
                ? { ...result, diagnostics }
                : result;
        },
        async read(runId: string, authorization: string | undefined) {
            if (!expected || !options.findByRun) return { status: 503 };
            if (
                !authorization ||
                !timingSafeEqual(expected, digest(authorization))
            )
                return { status: 401 };
            const root = await options.findByRun(runId);
            const identity = root.find(
                (row) => row.runId === runId && isTemplate(row.process),
            );
            if (!identity || !isTemplate(identity.process))
                return { status: 404 };
            const child =
                identity.process === "template-from-source"
                    ? await options.findByRun(`${runId}:compile`)
                    : [];
            const body = timeline(
                runId,
                identity.process,
                identity.version,
                root,
                child,
            );
            if (
                identity.process === "template-image-render" &&
                options.inspectRender &&
                body.steps.length
            ) {
                const receipt = attemptReceiptSchema.safeParse(
                    await options.inspectRender(runId).catch(() => undefined),
                );
                if (receipt.success)
                    return {
                        status: 200,
                        body: {
                            ...body,
                            steps: body.steps.map((step) => ({
                                ...step,
                                gateway: receipt.data,
                            })),
                        },
                    };
            }
            return { status: 200, body };
        },
    };
}
export type TemplateDiagnostics = ReturnType<typeof createTemplateDiagnostics>;
