import { expect, it, vi } from "vitest";
import { diagnosticSummary } from "../console/diagnostics.js";
import {
    createProcessAttemptRunner,
    defineProcessRegistration,
    failProcess,
    type ProcessRunLogRecord,
} from "../src/process-runtime/index.js";
import {
    templateInputSchema,
    templateOutputSchema,
    templateV3OutputSchema,
} from "../src/processes/template-from-image/contract.js";
import type { TemplateImagePreparation } from "../src/processes/template-from-source/capability.js";
import { createTemplateSourceRegistration } from "../src/processes/template-from-source/registration.js";

it.each([2, 3] as const)(
    "编译成员失败时父活动记录失败，保留副作用边界（运行语义 v%i）",
    async (runtimeVersion) => {
        const logs: ProcessRunLogRecord[] = [];
        const runner = createProcessAttemptRunner({
            logSink: (record) => logs.push(record),
        });
        const compile = vi.fn(async () =>
            failProcess("AGENT_FAILURE", "模板在独立复核修正后仍未通过校验"),
        );
        const compiler = defineProcessRegistration({
            id: "template-from-image",
            version: runtimeVersion === 3 ? "v2" : "v1",
            inputSchema: templateInputSchema,
            outputSchema:
                runtimeVersion === 3
                    ? templateV3OutputSchema
                    : templateOutputSchema,
            execute: compile,
        });
        const preparation: TemplateImagePreparation = {
            savePlan: vi.fn(),
            render: vi.fn(),
            finalize: vi.fn(async () => ({
                url: "https://assets.memebuy.cn/template.png",
                sha256: "a".repeat(64),
                width: 1024,
                height: 1024,
                contentType: "image/png" as const,
            })),
        };
        const registration = createTemplateSourceRegistration({
            runtimeVersion,
            compiler,
            attemptRunner: runner,
            preparation,
        });
        const accepted = registration.accept({
            productionId: "00000000-0000-4000-8000-000000000001",
            objectSha256: "a".repeat(64),
            reviewPackageSha256: "b".repeat(64),
            reviewerRef: "operator",
        });
        if (!accepted.accepted) throw new Error("测试输入未通过合同");
        const result = await runner.run({
            runId: "source-run",
            registration,
            acceptedInput: accepted.acceptedInput,
        });
        expect(result).toMatchObject({
            status: "failed",
            error: { code: "DEPENDENCY_FAILURE_AFTER_COMMIT" },
        });
        expect(compile).toHaveBeenCalledTimes(1);
        expect(preparation.render).not.toHaveBeenCalled();
        const activities = logs.filter(
            (record) => record.runId === "source-run",
        );
        expect(activities).toContainEqual(
            expect.objectContaining({
                event: "process_run_activity_finished",
                activity: "approved_image_compilation",
                outcome: "failed",
                diagnostic: { stage: "dependency", code: "dependency_failure" },
            }),
        );
        const summary = diagnosticSummary(
            {
                schemaVersion: 1,
                runId: "source-run",
                recordedAt: "2026-11-12T05:33:18.000Z",
                process: "template-from-source",
                version: registration.identity.version,
                status: "failed",
                errorCode: "DEPENDENCY_FAILURE_AFTER_COMMIT",
            },
            { runId: "source-run", activities },
        );
        expect(summary).toContain("approved_image_compilation");
        expect(summary).toContain("副作用已提交");
        expect(summary).not.toContain("无可用证据");
    },
);
