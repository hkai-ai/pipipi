import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { diagnosticSummary } from "../console/diagnostics.js";
import {
    formatProviderError,
    normalizeProviderError,
} from "../node_modules/@earendil-works/pi-ai/dist/utils/error-body.js";
import {
    agentDiagnostic,
    agentFailureMessage,
} from "../src/agent-runtime/diagnostics.js";
import { parseAgentJson } from "../src/agent-runtime/pi.js";
import { createJsonlProcessRunActivityArchive } from "../src/run-observation/jsonl.js";

const classify = (message: string) => {
    try {
        parseAgentJson([
            {
                role: "assistant",
                stopReason: "error",
                content: [],
                errorMessage: message,
            },
        ]);
    } catch (error) {
        return agentDiagnostic(error);
    }
    throw new Error("Expected failure");
};

it("pins the Pi error formatting contract to the installed version", () => {
    const metadata = JSON.parse(
        readFileSync(
            new URL(
                "../node_modules/@earendil-works/pi-ai/package.json",
                import.meta.url,
            ),
            "utf8",
        ),
    );
    expect(metadata.version).toBe("1.4.0");
});

it.each([
    [401, "authentication"],
    [429, "rate_limit"],
    [503, "provider_unavailable"],
] as const)(
    "Pi formatter preserves status %s in supported formats",
    (status, code) => {
        for (const body of [undefined, "synthetic body"]) {
            const error = Object.assign(
                new Error(`${status} synthetic failure`),
                { status, body },
            );
            for (const prefix of [undefined, "OpenAI API error"]) {
                expect(
                    classify(
                        formatProviderError(
                            normalizeProviderError(error),
                            prefix,
                        ),
                    ),
                ).toEqual({
                    stage: "request",
                    code: prefix || body ? code : "execution",
                });
            }
        }
    },
);

it("does not infer HTTP status from bare numeric prose", () => {
    for (const text of [
        "500 字以内的摘要不能为空",
        "401 Incorrect API key",
        "untrusted API error (401): prose",
    ]) {
        expect(classify(text).code).toBe("execution");
        expect(agentDiagnostic(new Error(text)).code).toBe("execution");
    }
});

it("keeps operator advice out of public messages", () => {
    const error = Object.assign(new Error("private"), { status: 401 });
    expect(agentFailureMessage("编译", error)).toContain("模型服务拒绝鉴权");
    expect(agentFailureMessage("编译", error)).not.toContain("凭证");
});

it("retains dependency handling advice even with an internal activity diagnostic", () => {
    const record = {
        schemaVersion: 1 as const,
        runId: "fixture",
        process: "fixture",
        version: "v1",
        status: "failed" as const,
        errorCode: "DEPENDENCY_FAILURE" as const,
        recordedAt: "2026-11-03T03:00:00.000Z",
    };
    const timeline = {
        runId: record.runId,
        activities: [
            {
                schemaVersion: 1 as const,
                runId: record.runId,
                process: "fixture",
                version: "v1",
                attemptNumber: 1,
                sequence: 1,
                timestamp: record.recordedAt,
                event: "process_run_activity_finished" as const,
                activity: "rendering",
                outcome: "failed" as const,
                durationMs: 1,
                diagnostic: {
                    stage: "execution" as const,
                    code: "internal_failure" as const,
                },
            },
        ],
    };
    expect(diagnosticSummary(record, timeline)).toContain(
        "重新提交前确认原请求是否已受理",
    );
});

it("projects historical JSONL events instead of exposing extra properties", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diagnostic-review-"));
    try {
        const now = new Date("2026-11-03T03:00:00.000Z");
        const archive = createJsonlProcessRunActivityArchive({
            directory,
            clock: () => now,
        });
        const entry = {
            schemaVersion: 1,
            runId: "fixture",
            process: "fixture",
            version: "v1",
            timestamp: now.toISOString(),
            attemptNumber: 1,
            sequence: 1,
            event: "process_run_activity_finished",
            activity: "compile",
            outcome: "failed",
            durationMs: 1,
            extra: "PRIVATE_SENTINEL",
            diagnostic: {
                stage: "schema",
                code: "invalid_schema",
                message: "PRIVATE_SENTINEL",
                issues: [{ path: "/PRIVATE_SENTINEL", code: "custom" }],
            },
        };
        await writeFile(
            join(directory, "activities-2026-11-03.jsonl"),
            `${JSON.stringify(entry)}\n`,
        );
        const records = await archive.findByRun("fixture");
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            diagnostic: { issues: [{ path: "/*", code: "custom" }] },
        });
        expect(JSON.stringify(records)).not.toContain("PRIVATE_SENTINEL");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
