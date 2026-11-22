/** 验证已下线的旧模板三阶段 Process 不在生产目录中，调用按未知 Process 拒绝且不触达任何依赖。 */
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessingApplication } from "../src/api/application.js";
import type { CallerIdentityResolver } from "../src/api/identity.js";
import { constructProcessingService } from "../src/app/api.js";
import { createProductionRuntime } from "../src/app/business-processes.js";
import { createAsyncProcessRuns } from "../src/process-runs/index.js";
import { createInMemoryProcessWorkQueue } from "../src/process-runs/queue/index.js";
import { createInMemoryProcessRunStore } from "../src/process-runs/store/index.js";

const approval = {
    productionId: "00000000-0000-4000-8000-000000000001",
    objectSha256: "a".repeat(64),
    reviewerRef: "reviewer",
};
/** 每个下线版本配上它原本能通过合同的输入，确保拒绝来自目录而不是参数校验。 */
const retired = [
    {
        process: "template-image-plan",
        version: "v1",
        input: { imageUrl: "https://assets.example.com/source.png" },
    },
    { process: "template-image-render", version: "v1", input: approval },
    ...["v1", "v2", "v3"].map((version) => ({
        process: "template-from-source",
        version,
        input: { ...approval, reviewPackageSha256: "b".repeat(64) },
    })),
] as const;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(closers.splice(0).map((close) => close()));
});

/** 记录内部 Business API 与模型网关收到的全部请求，以及测试应用以外的任何出站调用。 */
async function startDependencies() {
    const requests: string[] = [];
    const server = createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.writeHead(500).end();
    });
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    closers.push(
        () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("addr");
    const url = `http://127.0.0.1:${address.port}`;
    const outbound: string[] = [];
    const nativeFetch = globalThis.fetch;
    let applicationUrl = "";
    vi.stubGlobal(
        "fetch",
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const target = String(input instanceof Request ? input.url : input);
            if (!applicationUrl || !target.startsWith(applicationUrl))
                outbound.push(target);
            return nativeFetch(input, init);
        },
    );
    return {
        requests,
        outbound,
        environment: {
            CRT_BUSINESS_API_BASE_URL: url,
            MODEL_GATEWAY_BASE_URL: `${url}/v1`,
            MODEL_GATEWAY_API_KEY: "offline-test-key",
            PI_PROVIDER: "openai",
            PI_MODEL: "gpt-5.4",
            PROCESS_RUN_LOG_LEVEL: "silent",
        },
        observe: (url: string) => {
            applicationUrl = url;
        },
    };
}

describe("retired template three-stage Processes", () => {
    it("are absent from GET /processes and rejected by POST /execute without touching dependencies", async () => {
        const dependencies = await startDependencies();
        const { application } = constructProcessingService(
            dependencies.environment,
        );
        closers.push(application.close);
        const { url } = await application.listen();
        dependencies.observe(url);

        const catalog = (await (await fetch(`${url}/processes`)).json()) as {
            processes: { process: string; version: string }[];
        };
        const listed = catalog.processes.map(
            (entry) => `${entry.process}/${entry.version}`,
        );
        for (const { process, version } of retired)
            expect(listed).not.toContain(`${process}/${version}`);
        expect(listed).toEqual(
            expect.arrayContaining([
                "template-from-image/v3",
                "template-master/v1",
            ]),
        );

        for (const request of retired) {
            const response = await fetch(`${url}/execute`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(request),
            });
            expect(response.status).toBe(404);
            expect(await response.json()).toMatchObject({
                process: request.process,
                version: request.version,
                status: "failed",
                error: { code: "PROCESS_NOT_FOUND" },
            });
        }
        expect(dependencies.requests).toEqual([]);
        expect(dependencies.outbound).toEqual([]);
    });

    it("are rejected by POST /process-runs without creating a run, a job or a dependency call", async () => {
        const dependencies = await startDependencies();
        const { registry } = createProductionRuntime(dependencies.environment);
        const memory = createInMemoryProcessRunStore({ maxRuns: 10 });
        const accept = vi.fn(memory.accept);
        const store = { ...memory, accept };
        const queue = createInMemoryProcessWorkQueue({ maxJobs: 10 });
        const callerIdentity: CallerIdentityResolver = {
            resolve: async () => ({ callerId: "memebuy" }),
        };
        const application = createProcessingApplication({
            executor: {
                execute: async () => {
                    throw new Error("同步执行不应被调用");
                },
            },
            http: {
                logSink: () => {},
                asyncProcessRuns: {
                    runs: createAsyncProcessRuns({ registry, store, queue }),
                    callerIdentity,
                    readiness: async () => {},
                },
            },
        });
        closers.push(application.close);
        const { url } = await application.listen();
        dependencies.observe(url);

        for (const [index, request] of retired.entries()) {
            const response = await fetch(`${url}/process-runs`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "idempotency-key": `retired-${index}`,
                },
                body: JSON.stringify(request),
            });
            expect(response.status).toBe(404);
            expect(await response.json()).toMatchObject({
                error: { code: "PROCESS_NOT_FOUND" },
            });
        }
        expect(accept).not.toHaveBeenCalled();
        await expect(queue.take()).resolves.toBeUndefined();
        expect(dependencies.requests).toEqual([]);
        expect(dependencies.outbound).toEqual([]);
    });
});
