import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createProcessingRequestListener } from "../src/api/http.js";
import { createTemplateDiagnostics } from "../src/api/template-diagnostics.js";

const id = "00000000-0000-4000-8000-000000000001",
    secret = "fixture-".repeat(5);
const base = {
    schemaVersion: 1,
    timestamp: "2026-01-01T00:00:00Z",
    attemptNumber: 1,
    sequence: 2,
    version: "v2",
    event: "process_run_activity_finished",
} as const;
const root = {
    ...base,
    runId: id,
    process: "template-from-image",
    activity: "template_compilation",
    durationMs: 11421,
    outcome: "failed",
    diagnostic: {
        stage: "schema",
        code: "invalid_contract",
        issues: [{ path: "/review/secretName", code: "unresolved_review" }],
        private: "do not share",
    },
} as const;
const retired = "00000000-0000-4000-8000-000000000003";
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
    for (const server of servers.splice(0))
        await new Promise<void>((resolve) => server.close(() => resolve()));
});

it("读取历史记录与新回执一致，过滤其他运行、流程、动态字段和未授权读取", async () => {
    const reads: string[] = [];
    const diag = createTemplateDiagnostics({
        secret,
        findByRun: async (runId) => {
            reads.push(runId);
            return runId === id
                ? [
                      root,
                      { ...root, activity: "do not share" },
                      { ...root, version: "v1" },
                      { ...root, runId: "unrelated" },
                  ]
                : runId === retired
                  ? [
                        {
                            ...root,
                            runId,
                            process: "template-from-source",
                            activity: "approved_image_compilation",
                        },
                    ]
                  : [{ ...root, runId, process: "news-image" }];
        },
    });
    let calls = 0;
    const server = createServer(
        createProcessingRequestListener(
            {
                execute: async () => {
                    calls++;
                    diag.record(root);
                    return {
                        runId: id,
                        process: root.process,
                        version: "v2",
                        status: "failed",
                        error: {
                            code: "DEPENDENCY_FAILURE_AFTER_COMMIT",
                            message: "failed",
                        },
                    };
                },
            },
            { templateDiagnostics: diag, logSink: () => {} },
        ),
    );
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("no TCP address");
    const origin = `http://127.0.0.1:${address.port}`;
    const path = (runId: string) =>
        `${origin}/memebuy/template-runs/${runId}/diagnostics`;
    expect((await fetch(path(id))).status).toBe(401);
    expect(reads).toEqual([]);
    const headers = { Authorization: `Bearer ${secret}` };
    expect((await fetch(path(`${id}:compile`), { headers })).status).toBe(404);
    // 已下线的 template-from-source 历史运行不再投影步骤。
    expect((await fetch(path(retired), { headers })).status).toBe(404);
    expect(
        (await fetch(path("00000000-0000-4000-8000-000000000002"), { headers }))
            .status,
    ).toBe(404);
    const history = await fetch(path(id), { headers });
    expect(history.status).toBe(200);
    const timeline = await history.json();
    expect(timeline.steps).toEqual([
        {
            scope: "main",
            activity: root.activity,
            status: "failed",
            durationMs: 11421,
            diagnostic: {
                code: "invalid_contract",
                stage: "schema",
                issues: [{ path: "/review/*", code: "unresolved_review" }],
            },
        },
    ]);
    expect(calls).toBe(0);
    const post = (extra: Record<string, string>) =>
        fetch(`${origin}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json", ...extra },
            body: JSON.stringify({
                process: root.process,
                version: "v2",
                input: {},
            }),
        });
    expect((await (await post({})).json()).diagnostics).toBeUndefined();
    expect(
        (await (await post({ "x-pipipi-template-steps": "1" })).json())
            .diagnostics,
    ).toEqual(timeline);
    expect(calls).toBe(2);
});
