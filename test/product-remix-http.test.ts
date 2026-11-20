/** 商品做同款（product-remix/v1）端到端 HTTP、/processes 注册表、幂等、排队门禁、费用与 URL 红线集成契约测试。 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessingApplication } from "../src/api/application.js";
import type { CallerIdentityResolver } from "../src/api/identity.js";
import { describeProcessCatalog } from "../src/api/process-catalog.js";
import { createAsyncProcessRuns } from "../src/process-runs/index.js";
import { createInMemoryProcessWorkQueue } from "../src/process-runs/queue/index.js";
import {
    createInMemoryProcessRunStore,
    ProcessRunBacklogLimitError,
    type ProcessRunStore,
} from "../src/process-runs/store/index.js";
import {
    createProcessWorker,
    createProcessWorkerDrain,
} from "../src/process-runs/worker/index.js";
import { recordKnownCost } from "../src/process-runtime/cost.js";
import {
    createProcessAttemptRunner,
    createProcessRegistry,
    createProcessRunner,
} from "../src/process-runtime/index.js";
import type {
    ProductRemixAgent,
    RemixPlan,
    RemixVerification,
} from "../src/processes/product-remix/agent.js";
import type { ProductRemixCapability } from "../src/processes/product-remix/capability.js";
import {
    isProductRemixImageUrl,
    productRemixOutputSchema,
} from "../src/processes/product-remix/contract.js";
import { createProductRemixRegistration } from "../src/processes/product-remix/registration.js";

const sourceImageUrl = "https://assets.example.com/prints/retro-flower.png";
const referenceImageUrl =
    "https://private.example.com/uploads/corgi.jpg?Expires=1800000000&Signature=sig123";

const sha256 = (value: string) =>
    createHash("sha256").update(value).digest("hex");

const png = (width: number, height: number, background = "#fff") =>
    sharp({
        create: { width, height, channels: 3, background },
    })
        .png()
        .toBuffer();

const runningClosers: Array<() => Promise<void>> = [];

afterEach(async () => {
    await Promise.all(runningClosers.splice(0).map((close) => close()));
});

async function startArtifactCheckServer(bytes: Buffer): Promise<{
    directUrl: string;
    redirectUrl: string;
}> {
    const server: Server = createServer((req, res) => {
        if (req.url === "/direct.png") {
            res.writeHead(200, {
                "content-type": "image/png",
                "content-length": bytes.byteLength,
            });
            res.end(bytes);
            return;
        }
        if (req.url === "/redirect.png") {
            res.writeHead(302, { location: "/direct.png" });
            res.end();
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    runningClosers.push(
        () =>
            new Promise<void>((resolve, reject) =>
                server.close((err) => (err ? reject(err) : resolve())),
            ),
    );
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("bad addr");
    const base = `http://127.0.0.1:${addr.port}`;
    return {
        directUrl: `${base}/direct.png`,
        redirectUrl: `${base}/redirect.png`,
    };
}

async function startHarness(
    options: {
        plan?: ProductRemixAgent["plan"];
        verify?: ProductRemixAgent["verify"];
        edit?: ProductRemixCapability["edit"];
        upload?: ProductRemixCapability["upload"];
        timeoutMsOverride?: number;
    } = {},
) {
    const sourcePng = await png(1024, 1024, "#fef3c7");
    const refPng = await png(800, 1000, "#fde68a");
    const outputPng = await png(896, 1152, "#bfdbfe");

    const planMock = vi.fn<ProductRemixAgent["plan"]>(
        options.plan ??
            (async (req) => {
                recordKnownCost(0.015, "provider");
                return {
                    tier: req.referenceViews.length ? "medium" : "light",
                    rationale: req.referenceViews.length
                        ? "融合图 2 主体到图 1 风格"
                        : "局部改文字与配色",
                    editPrompt:
                        "Edit the print design faithfully following userText while preserving pure flat printable layout.",
                    expectedTexts: req.referenceViews.length
                        ? []
                        : ["HAPPY BIRTHDAY"],
                    forbiddenTexts: [],
                    keepOriginalStyle: true,
                } satisfies RemixPlan;
            }),
    );
    const verifyMock = vi.fn<ProductRemixAgent["verify"]>(
        options.verify ??
            (async () => {
                recordKnownCost(0.01, "provider");
                return {
                    intentFollowed: true,
                    textAccurate: true,
                    noMockup: true,
                    notCropped: true,
                    issues: [],
                } satisfies RemixVerification;
            }),
    );
    const editMock = vi.fn<ProductRemixCapability["edit"]>(
        options.edit ??
            (async () => {
                recordKnownCost(0.04, "provider");
                return {
                    bytes: outputPng,
                    width: 896,
                    height: 1152,
                    modelName: "gpt-image-2.5-flare",
                };
            }),
    );
    const uploadMock = vi.fn<ProductRemixCapability["upload"]>(
        options.upload ??
            (async (bytes) => {
                const digest = createHash("sha256").update(bytes).digest("hex");
                return {
                    url: `https://assets.example.com/product-remix/${digest}.png`,
                    width: 896,
                    height: 1152,
                };
            }),
    );

    const baseRegistration = createProductRemixRegistration({
        capability: { edit: editMock, upload: uploadMock },
        agent: { plan: planMock, verify: verifyMock },
        loadSource: async (url) =>
            url === sourceImageUrl ? sourcePng : refPng,
    });
    const registration =
        options.timeoutMsOverride === undefined
            ? baseRegistration
            : { ...baseRegistration, timeoutMs: options.timeoutMsOverride };

    const registry = createProcessRegistry([registration]);
    const baseStore = createInMemoryProcessRunStore({ maxRuns: 50 });
    let simulatedBacklogError: ProcessRunBacklogLimitError | undefined;
    const store: ProcessRunStore = {
        ...baseStore,
        accept: async (run) => {
            if (simulatedBacklogError) {
                throw simulatedBacklogError;
            }
            return baseStore.accept(run);
        },
    };
    const queue = createInMemoryProcessWorkQueue({ maxJobs: 50 });
    let tick = 0;
    const clock = () =>
        new Date(Date.UTC(2026, 10, 20, 12, 0, tick++)).toISOString();
    let runCounter = 0;
    const runs = createAsyncProcessRuns({
        registry,
        store,
        queue,
        clock,
        createRunId: () =>
            `20000000-0000-4000-8000-${String(++runCounter).padStart(12, "0")}`,
    });
    let claimCounter = 0;
    const worker = createProcessWorker({
        registry,
        store,
        attemptRunner: createProcessAttemptRunner(),
        clock,
        createClaimToken: () =>
            `30000000-0000-4000-8000-${String(++claimCounter).padStart(12, "0")}`,
    });

    const callerIdentity: CallerIdentityResolver = {
        resolve: async (headers) => {
            const auth = headers.authorization;
            if (
                typeof auth === "string" &&
                auth === "Bearer memebuy-caller-token"
            ) {
                return {
                    callerId: "memebuy-worker",
                    authMethod: "api_key" as const,
                };
            }
            return undefined;
        },
    };

    const application = createProcessingApplication({
        executor: createProcessRunner({ registry }),
        http: {
            executeAuthMode: "required",
            callerIdentity,
            processes: describeProcessCatalog(registry),
            asyncProcessRuns: {
                runs,
                callerIdentity,
                readiness: async () => {},
            },
        },
    });
    runningClosers.push(() => application.close());
    const { url } = await application.listen();

    return {
        url,
        outputPng,
        queue,
        drain: createProcessWorkerDrain({ source: queue, worker }),
        planMock,
        verifyMock,
        editMock,
        uploadMock,
        setBacklogError(error: ProcessRunBacklogLimitError | undefined) {
            simulatedBacklogError = error;
        },
    };
}

function postAsyncRun(
    baseUrl: string,
    body: unknown,
    idempotencyKey = "product.remix:task-1:1",
) {
    return fetch(`${baseUrl}/process-runs`, {
        method: "POST",
        headers: {
            authorization: "Bearer memebuy-caller-token",
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
            "x-request-id": "memebuy-req-001",
        },
        body: JSON.stringify(body),
    });
}

function getAsyncRun(baseUrl: string, runId: string) {
    return fetch(`${baseUrl}/process-runs/${runId}`, {
        headers: { authorization: "Bearer memebuy-caller-token" },
    });
}

describe("product-remix/v1 HTTP 与异步契约集成验收", () => {
    it("GET /processes 暴露 product-remix@v1，并对非法输入返回 400 INVALID_INPUT 且零模型调用", async () => {
        const h = await startHarness();

        const catalogRes = await fetch(`${h.url}/processes`);
        expect(catalogRes.status).toBe(200);
        const catalogBody = (await catalogRes.json()) as {
            processes: Array<{ process: string; version: string }>;
        };
        expect(catalogBody.processes).toContainEqual(
            expect.objectContaining({
                process: "product-remix",
                version: "v1",
            }),
        );

        const invalidInputs: Array<[string, unknown]> = [
            [
                "未知多余字段",
                {
                    sourceImageUrl,
                    userText: "改图",
                    budget: { maxAttempts: 3, maxUsd: 1 },
                    model: "custom-model",
                },
            ],
            [
                "非 HTTPS",
                {
                    sourceImageUrl: "http://assets.example.com/a.png",
                    userText: "改图",
                    budget: { maxAttempts: 3, maxUsd: 1 },
                },
            ],
            [
                "含端口",
                {
                    sourceImageUrl: "https://assets.example.com:8443/a.png",
                    userText: "改图",
                    budget: { maxAttempts: 3, maxUsd: 1 },
                },
            ],
            [
                "含 x-oss-process",
                {
                    sourceImageUrl:
                        "https://assets.example.com/a.png?x-oss-process=image/resize,w_200",
                    userText: "改图",
                    budget: { maxAttempts: 3, maxUsd: 1 },
                },
            ],
            [
                "budget.maxUsd <= 0",
                {
                    sourceImageUrl,
                    userText: "改图",
                    budget: { maxAttempts: 3, maxUsd: 0 },
                },
            ],
        ];

        for (const [index, [label, input]] of invalidInputs.entries()) {
            const res = await postAsyncRun(
                h.url,
                { process: "product-remix", version: "v1", input },
                `product.remix:invalid:${index}`,
            );
            expect(res.status, label).toBe(400);
            expect(await res.json(), label).toMatchObject({
                status: "failed",
                error: { code: "INVALID_INPUT" },
            });
        }

        expect(h.planMock).not.toHaveBeenCalled();
        expect(h.editMock).not.toHaveBeenCalled();
        await expect(h.queue.take()).resolves.toBeUndefined();
    });

    it("支持 light 与 medium/heavy 双模式闭环，并回传合法产物、URL 红线与 USD 费用", async () => {
        const h = await startHarness();

        const lightSubmit = await postAsyncRun(
            h.url,
            {
                process: "product-remix",
                version: "v1",
                input: {
                    sourceImageUrl,
                    userText: "把图案里的文字改成 HAPPY BIRTHDAY，配色换成蓝白",
                    budget: { maxAttempts: 3, maxUsd: 1 },
                },
            },
            "product.remix:task-light:1",
        );
        expect(lightSubmit.status).toBe(202);
        const lightAccepted = (await lightSubmit.json()) as { runId: string };
        expect(await h.drain.drainOne()).toBe("processed");

        const lightPoll = await getAsyncRun(h.url, lightAccepted.runId);
        expect(lightPoll.status).toBe(200);
        const lightView = (await lightPoll.json()) as {
            status: string;
            output: {
                image: { url: string; width: number; height: number };
                modelName: string;
                resolvedTier: string;
            };
            cost: {
                currency: string;
                amount: number;
                source: string;
                complete: boolean;
            };
        };
        expect(lightView.status).toBe("succeeded");
        const parsedLightOutput = productRemixOutputSchema.parse(
            lightView.output,
        );
        expect(parsedLightOutput.resolvedTier).toBe("light");
        expect(parsedLightOutput.modelName).toBe("gpt-image-2.5-flare");
        expect(isProductRemixImageUrl(parsedLightOutput.image.url)).toBe(true);
        expect(sha256(parsedLightOutput.image.url)).not.toBe(
            sha256(sourceImageUrl),
        );
        expect(lightView.cost).toEqual({
            currency: "USD",
            amount: 0.065,
            source: "provider",
            complete: true,
        });

        const heavySubmit = await postAsyncRun(
            h.url,
            {
                process: "product-remix",
                version: "v1",
                input: {
                    sourceImageUrl,
                    referenceImageUrl,
                    userText: "把主体换成图 2 里的狗狗，保留原图插画风格",
                    imageSize: "896x1152",
                    budget: { maxAttempts: 3, maxUsd: 1 },
                },
            },
            "product.remix:task-heavy:1",
        );
        expect(heavySubmit.status).toBe(202);
        const heavyAccepted = (await heavySubmit.json()) as { runId: string };
        expect(await h.drain.drainOne()).toBe("processed");

        const heavyPoll = await getAsyncRun(h.url, heavyAccepted.runId);
        const heavyView = (await heavyPoll.json()) as {
            status: string;
            output: {
                image: { url: string; width: number; height: number };
                resolvedTier: string;
            };
            cost: { currency: string; amount: number; complete: boolean };
        };
        expect(heavyView.status).toBe("succeeded");
        expect(heavyView.output.resolvedTier).toBe("medium");
        expect(sha256(heavyView.output.image.url)).not.toBe(
            sha256(sourceImageUrl),
        );
        expect(sha256(heavyView.output.image.url)).not.toBe(
            sha256(referenceImageUrl),
        );
        expect(h.editMock.mock.calls[1]?.[0].images).toHaveLength(2);
        expect(heavyView.cost).toEqual({
            currency: "USD",
            amount: 0.065,
            source: "provider",
            complete: true,
        });
    });

    it("质检首轮失败触发第 2 轮修正并成功；预算耗尽返回 AGENT_FAILURE 且带累计 cost", async () => {
        let qcCall = 0;
        const h = await startHarness({
            verify: async () => {
                qcCall += 1;
                recordKnownCost(0.01, "provider");
                if (qcCall <= 1) {
                    return {
                        intentFollowed: true,
                        textAccurate: false,
                        noMockup: true,
                        notCropped: true,
                        issues: ["文字拼写有误"],
                    };
                }
                return {
                    intentFollowed: true,
                    textAccurate: true,
                    noMockup: true,
                    notCropped: true,
                    issues: [],
                };
            },
        });

        const retrySubmit = await postAsyncRun(
            h.url,
            {
                process: "product-remix",
                version: "v1",
                input: {
                    sourceImageUrl,
                    userText: "改文字为 HAPPY BIRTHDAY",
                    budget: { maxAttempts: 3, maxUsd: 1 },
                },
            },
            "product.remix:task-qc-retry:1",
        );
        const retryRun = (await retrySubmit.json()) as { runId: string };
        expect(await h.drain.drainOne()).toBe("processed");

        const retryView = (await (
            await getAsyncRun(h.url, retryRun.runId)
        ).json()) as {
            status: string;
            cost: { amount: number; complete: boolean };
        };
        expect(retryView.status).toBe("succeeded");
        expect(retryView.cost).toEqual({
            currency: "USD",
            amount: 0.115,
            source: "provider",
            complete: true,
        });

        // 预算耗尽（每轮持续失败直至 maxAttempts=2 耗尽）
        qcCall = -100;
        const failSubmit = await postAsyncRun(
            h.url,
            {
                process: "product-remix",
                version: "v1",
                input: {
                    sourceImageUrl,
                    referenceImageUrl,
                    userText: "重绘",
                    budget: { maxAttempts: 2, maxUsd: 1 },
                },
            },
            "product.remix:task-fail:1",
        );
        const failRun = (await failSubmit.json()) as { runId: string };
        expect(await h.drain.drainOne()).toBe("processed");

        const failView = (await (
            await getAsyncRun(h.url, failRun.runId)
        ).json()) as {
            status: string;
            output?: unknown;
            error: { code: string; message: string };
            cost: { currency: string; amount: number; complete: boolean };
        };
        expect(failView.status).toBe("failed");
        expect(failView.output).toBeUndefined();
        expect(failView.error.code).toBe("AGENT_FAILURE");
        expect(JSON.stringify(failView)).not.toContain(sourceImageUrl);
        expect(JSON.stringify(failView)).not.toContain(referenceImageUrl);
        expect(failView.cost).toEqual({
            currency: "USD",
            amount: 0.115,
            source: "provider",
            complete: true,
        });
    });

    it("强制幂等重放、异参 409、队列背压拒绝不占幂等键，以及无重定向 200 直取约束", async () => {
        const h = await startHarness();
        const artifactServer = await startArtifactCheckServer(h.outputPng);

        const directFetch = await fetch(artifactServer.directUrl, {
            redirect: "error",
            signal: AbortSignal.timeout(60_000),
        });
        expect(directFetch.status).toBe(200);
        expect(Buffer.from(await directFetch.arrayBuffer())).toEqual(
            h.outputPng,
        );
        await expect(
            fetch(artifactServer.redirectUrl, {
                redirect: "error",
                signal: AbortSignal.timeout(60_000),
            }),
        ).rejects.toThrow();

        // 429 背压拒绝时不占用幂等键，释放容量后同键重投成功
        const payload = {
            process: "product-remix",
            version: "v1",
            input: {
                sourceImageUrl,
                userText: "把文字改成 HELLO",
                budget: { maxAttempts: 3, maxUsd: 1 },
            },
        };
        h.setBacklogError(new ProcessRunBacklogLimitError("caller", 5));
        const rejected429 = await postAsyncRun(
            h.url,
            payload,
            "product.remix:task-idem:1",
        );
        expect(rejected429.status).toBe(429);
        expect(h.planMock).not.toHaveBeenCalled();

        h.setBacklogError(new ProcessRunBacklogLimitError("global", 5));
        const rejected503 = await postAsyncRun(
            h.url,
            payload,
            "product.remix:task-idem:1",
        );
        expect(rejected503.status).toBe(503);
        expect(h.planMock).not.toHaveBeenCalled();

        h.setBacklogError(undefined);
        const firstSubmit = await postAsyncRun(
            h.url,
            payload,
            "product.remix:task-idem:1",
        );
        expect(firstSubmit.status).toBe(202);
        const firstBody = (await firstSubmit.json()) as { runId: string };

        const replaySubmit = await postAsyncRun(
            h.url,
            payload,
            "product.remix:task-idem:1",
        );
        expect(replaySubmit.status).toBe(202);
        expect((await replaySubmit.json()) as { runId: string }).toEqual(
            firstBody,
        );

        const conflictSubmit = await postAsyncRun(
            h.url,
            {
                ...payload,
                input: {
                    ...payload.input,
                    userText: "完全不同的编辑指令",
                },
            },
            "product.remix:task-idem:1",
        );
        expect(conflictSubmit.status).toBe(409);
        expect(await conflictSubmit.json()).toMatchObject({
            error: { code: "IDEMPOTENCY_CONFLICT" },
        });
    });

    it("流程超时返回 PROCESS_TIMEOUT 终态", async () => {
        const h = await startHarness({
            timeoutMsOverride: 25,
            plan: async (req) =>
                await new Promise((_, reject) => {
                    req.signal.addEventListener(
                        "abort",
                        () => reject(new Error("aborted")),
                        { once: true },
                    );
                }),
        });

        const submit = await postAsyncRun(
            h.url,
            {
                process: "product-remix",
                version: "v1",
                input: {
                    sourceImageUrl,
                    userText: "慢请求测试",
                    budget: { maxAttempts: 2, maxUsd: 1 },
                },
            },
            "product.remix:task-timeout:1",
        );
        expect(submit.status).toBe(202);
        const accepted = (await submit.json()) as { runId: string };

        expect(await h.drain.drainOne()).toBe("processed");
        const poll = await getAsyncRun(h.url, accepted.runId);
        expect(poll.status).toBe(200);
        expect(await poll.json()).toMatchObject({
            status: "failed",
            error: { code: "PROCESS_TIMEOUT" },
        });
    });
});
