import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { observePiSession, promptPi } from "../src/agent-runtime/trace.js";
import { startLocalCrtBusinessApi } from "../src/business-api/crt-server.js";
import { OpenAIImageGenerationClient } from "../src/business-api/openai-image-generation.js";
import {
    businessApiCostHeader,
    createCostLedger,
    decodeCostLedger,
    fetchBilled,
    recordGatewayResponseCost,
    recordKnownCost,
    withCostLedger,
} from "../src/process-runtime/cost.js";
import {
    createProcessAttemptRunner,
    defineProcessRegistration,
} from "../src/process-runtime/index.js";
import { HttpTemplateMasterCapability } from "../src/processes/template-master/capability.http.js";

const runId = "00000000-0000-4000-8000-0000000000c0";
function definition(
    execute: (
        input: unknown,
        context: { signal: AbortSignal },
    ) => Promise<Record<string, never>>,
    timeoutMs?: number,
) {
    return defineProcessRegistration({
        id: "cost-test",
        version: "v1",
        ...(timeoutMs ? { timeoutMs } : {}),
        inputSchema: z.strictObject({}),
        outputSchema: z.strictObject({}),
        execute,
    });
}
function accepted(registration: ReturnType<typeof definition>) {
    const result = registration.accept({});
    if (!result.accepted) throw new Error("fixture input rejected");
    return result.acceptedInput;
}

describe("费用账本", () => {
    it("只在有已知费用时给出摘要，并消除浮点累加噪声", () => {
        const ledger = createCostLedger();
        ledger.recordUnknown();
        expect(ledger.summary()).toBeUndefined();
        ledger.recordKnown(0.1, "provider");
        ledger.recordKnown(0.2, "provider");
        expect(ledger.summary()).toEqual({
            currency: "USD",
            amount: 0.3,
            source: "provider",
            complete: false,
        });
    });

    it("拒绝非法金额并按未知处理", () => {
        const ledger = createCostLedger();
        ledger.recordKnown(-1, "provider");
        ledger.recordKnown(Number.NaN, "estimate");
        expect(ledger.snapshot()).toEqual({
            usd: 0,
            provider: 0,
            estimate: 0,
            unknown: 2,
        });
    });

    it.each([
        ["0.0123", 0.0123],
        ["0", 0],
        ["1e-05", 0.00001],
    ])("网关费用头 %s 计为供应商已知费用", (header, expected) => {
        const ledger = createCostLedger();
        withCostLedger(ledger, () =>
            recordGatewayResponseCost(
                new Headers({ "x-litellm-response-cost": header }),
            ),
        );
        expect(ledger.summary()).toMatchObject({
            amount: expected,
            source: "provider",
            complete: true,
        });
    });

    it.each([[undefined], ["abc"], ["-1"], [""]])(
        "网关费用头缺失或非法（%s）计为未知，不估算",
        (header) => {
            const ledger = createCostLedger();
            withCostLedger(ledger, () =>
                recordGatewayResponseCost(
                    new Headers(
                        header === undefined
                            ? {}
                            : { "x-litellm-response-cost": header },
                    ),
                ),
            );
            expect(ledger.snapshot().unknown).toBe(1);
            expect(ledger.summary()).toBeUndefined();
        },
    );

    it("只接受结构完整的 Business API 账本头", () => {
        expect(
            decodeCostLedger(
                '{"usd":0.5,"provider":1,"estimate":0,"unknown":2}',
            ),
        ).toEqual({ usd: 0.5, provider: 1, estimate: 0, unknown: 2 });
        for (const raw of [
            null,
            "{",
            '{"usd":-1,"provider":0,"estimate":0,"unknown":0}',
            '{"usd":1,"provider":0.5,"estimate":0,"unknown":0}',
            '{"usd":"1","provider":0,"estimate":0,"unknown":0}',
        ])
            expect(decodeCostLedger(raw)).toBeUndefined();
    });
});

describe("Attempt 费用累计", () => {
    it("子流程费用并入父运行，子流程失败时已发生的费用仍计入", async () => {
        const runner = createProcessAttemptRunner();
        const child = definition(async () => {
            recordKnownCost(0.2, "provider");
            throw new Error("boom");
        });
        const parent = definition(async () => {
            recordKnownCost(0.1, "estimate");
            const result = await runner.run({
                runId: `${runId}:child`,
                registration: child,
                acceptedInput: accepted(child),
            });
            expect(result.cost?.amount).toBe(0.2);
            return {};
        });
        const result = await runner.run({
            runId,
            registration: parent,
            acceptedInput: accepted(parent),
        });
        expect(result).toMatchObject({
            status: "succeeded",
            cost: {
                currency: "USD",
                amount: 0.3,
                source: "mixed",
                complete: true,
            },
        });
    });

    it("超时的运行保留已累计费用并标记为下限", async () => {
        const runner = createProcessAttemptRunner();
        const slow = definition(async (_input, context) => {
            recordKnownCost(0.04, "provider");
            await new Promise((_resolve, reject) =>
                context.signal.addEventListener("abort", () => reject(), {
                    once: true,
                }),
            );
            return {};
        }, 20);
        const result = await runner.run({
            runId,
            registration: slow,
            acceptedInput: accepted(slow),
        });
        expect(result).toMatchObject({
            status: "failed",
            error: { code: "PROCESS_TIMEOUT" },
            cost: { amount: 0.04, source: "provider", complete: false },
        });
    });

    it("外部取消同样保留费用并标记为下限", async () => {
        const runner = createProcessAttemptRunner();
        const controller = new AbortController();
        const waiting = definition(async () => {
            recordKnownCost(0.01, "provider");
            controller.abort();
            await new Promise(() => {});
            return {};
        });
        const result = await runner.run({
            runId,
            registration: waiting,
            acceptedInput: accepted(waiting),
            signal: controller.signal,
        });
        expect(result.cost).toMatchObject({ amount: 0.01, complete: false });
    });

    it("没有任何已知费用时不带 cost 字段", async () => {
        const runner = createProcessAttemptRunner();
        const free = definition(async () => ({}));
        const result = await runner.run({
            runId,
            registration: free,
            acceptedInput: accepted(free),
        });
        expect("cost" in result).toBe(false);
    });
});

function fakeSession(cost: unknown) {
    let publish!: (event: unknown) => void;
    const session = {
        agent: {},
        resourceLoader: { getSkills: () => ({ skills: [] }) },
        subscribe: (listener: (event: unknown) => void) => {
            publish = listener;
        },
        prompt: async () => {
            await (
                session.agent as {
                    onPayload?: (p: unknown, m: unknown) => Promise<void>;
                }
            ).onPayload?.({}, { api: "openai-responses", id: "test" });
            publish({
                type: "message_end",
                message: {
                    role: "assistant",
                    content: [],
                    stopReason: "stop",
                    usage: { cost },
                },
            });
        },
    };
    return { session };
}

describe("Pi 模型调用费用", () => {
    it.each([
        [{ total: 0.0012, totalFromProvider: true }, 0.0012, "provider"],
        [{ total: 0, totalFromProvider: true }, 0, "provider"],
        [{ total: 0.02 }, 0.02, "estimate"],
    ])("复用 trace 的费用投影：%j", async (cost, amount, source) => {
        const ledger = createCostLedger();
        const { session } = fakeSession(cost);
        await withCostLedger(ledger, async () => {
            // 无轨迹活动范围时账本仍须累计。
            observePiSession(session as never, new Map(), []);
            await promptPi(session as never, "PRIVATE");
        });
        expect(ledger.summary()).toEqual({
            currency: "USD",
            amount,
            source,
            complete: true,
        });
    });

    it.each([[{ total: 0 }], [undefined], [{ total: -1 }]])(
        "零估算或缺失用量不当作免费，记为未知：%j",
        async (cost) => {
            const ledger = createCostLedger();
            const { session } = fakeSession(cost);
            await withCostLedger(ledger, async () => {
                observePiSession(session as never, new Map(), []);
                await promptPi(session as never, "PRIVATE");
            });
            expect(ledger.snapshot()).toMatchObject({ unknown: 1, usd: 0 });
            expect(ledger.summary()).toBeUndefined();
        },
    );
});

const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
    Buffer.from("00000400000006a0", "hex"),
]);
function imageClient(respond: () => Response | Promise<Response>) {
    return new OpenAIImageGenerationClient({
        apiKey: "test-key",
        baseUrl: "https://gateway.example/v1",
        fetch: async () => respond(),
    });
}
function imageBody() {
    return { data: [{ b64_json: png.toString("base64") }] };
}

describe("图片通道费用", () => {
    it("OpenAI 兼容网关读取 x-litellm-response-cost", async () => {
        const ledger = createCostLedger();
        const client = imageClient(() =>
            Response.json(imageBody(), {
                headers: { "x-litellm-response-cost": "0.039" },
            }),
        );
        await withCostLedger(ledger, () => client.generate({ prompt: "p" }));
        expect(ledger.summary()).toMatchObject({
            amount: 0.039,
            source: "provider",
            complete: true,
        });
    });

    it("响应头缺失、HTTP 失败或没有响应时记为未知", async () => {
        const ledger = createCostLedger();
        await withCostLedger(ledger, async () => {
            await imageClient(() => Response.json(imageBody())).generate({
                prompt: "p",
            });
            await imageClient(() =>
                Response.json({ error: { code: "x" } }, { status: 500 }),
            )
                .generate({ prompt: "p" })
                .catch(() => {});
            await imageClient(() => {
                throw new Error("offline");
            })
                .generate({ prompt: "p" })
                .catch(() => {});
        });
        expect(ledger.snapshot()).toMatchObject({ unknown: 3, usd: 0 });
    });
});

describe("内部 Business API 费用回传", () => {
    it("调用方并入账本头；无头或 202 记为未知；断连记为未知", async () => {
        const server = createServer((request, response) => {
            const route = request.url ?? "";
            const ledger = JSON.stringify({
                usd: 0.04,
                provider: 1,
                estimate: 0,
                unknown: 0,
            });
            if (route === "/headed")
                response.writeHead(200, { [businessApiCostHeader]: ledger });
            else if (route === "/pending")
                response.writeHead(202, { [businessApiCostHeader]: ledger });
            else response.writeHead(200);
            response.end("{}");
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("addr");
        const base = `http://127.0.0.1:${address.port}`;
        try {
            const ledger = createCostLedger();
            await withCostLedger(ledger, async () => {
                await fetchBilled(fetch, `${base}/headed`);
                expect(ledger.snapshot().unknown).toBe(0);
                await fetchBilled(fetch, `${base}/legacy`);
                expect(ledger.snapshot().unknown).toBe(1);
                await fetchBilled(fetch, `${base}/pending`);
            });
            expect(ledger.snapshot()).toEqual({
                usd: 0.08,
                provider: 2,
                estimate: 0,
                unknown: 2,
            });
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
        const offline = createCostLedger();
        await withCostLedger(offline, () =>
            fetchBilled(fetch, `${base}/headed`).catch(() => {}),
        );
        expect(offline.snapshot().unknown).toBe(1);
    });

    it("Business API 按请求独立记账，并经响应头回传图片费用", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pipipi-cost-api-"));
        const output = await sharp({
            create: {
                width: 320,
                height: 240,
                channels: 3,
                background: "#789",
            },
        })
            .png()
            .toBuffer();
        const api = await startLocalCrtBusinessApi({
            directory,
            imageClient: {
                edit: async () => {
                    recordKnownCost(0.04, "provider");
                    return {
                        bytes: output,
                        mimeType: "image/png",
                        outputFormat: "png" as const,
                        width: 320,
                        height: 240,
                    };
                },
            },
        });
        try {
            const health = await fetch(`${api.url}/healthz`);
            expect(
                decodeCostLedger(health.headers.get(businessApiCostHeader)),
            ).toEqual({ usd: 0, provider: 0, estimate: 0, unknown: 0 });
            const response = await fetch(`${api.url}/crt-images`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "idempotency-key": "cost-1",
                },
                body: JSON.stringify({
                    sourceImageUrl: "https://images.example.com/source.png",
                    prompt: "CRT",
                    palette: "经典",
                    aspectRatio: "4:3",
                    grain: "normal",
                }),
            });
            expect(response.status).toBe(200);
            expect(
                decodeCostLedger(response.headers.get(businessApiCostHeader)),
            ).toEqual({ usd: 0.04, provider: 1, estimate: 0, unknown: 0 });
        } finally {
            await api.close();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("母版改图经内部服务返回的费用进入 Process 结果，失败响应同样带费用", async () => {
        const ledgerHeader = (usd: number, provider: number) =>
            JSON.stringify({ usd, provider, estimate: 0, unknown: 0 });
        const server = createServer((request, response) => {
            request.resume();
            request.on("end", () => {
                response.writeHead(503, {
                    "content-type": "application/json",
                    [businessApiCostHeader]: ledgerHeader(0.039, 1),
                });
                response.end(
                    JSON.stringify({ error: { reason: "incomplete" } }),
                );
            });
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("addr");
        try {
            const capability = new HttpTemplateMasterCapability(
                `http://127.0.0.1:${address.port}`,
            );
            const registration = defineProcessRegistration({
                id: "template-master",
                version: "v1",
                inputSchema: z.strictObject({}),
                outputSchema: z.strictObject({}),
                execute: async (_input, context) => {
                    await capability.edit({
                        image: Buffer.from("png"),
                        prompt: "保留版式",
                        size: "1024x1024",
                        idempotencyKey: "master-cost",
                        signal: context.signal,
                    });
                    return {};
                },
            });
            const result = await createProcessAttemptRunner().run({
                runId,
                registration,
                acceptedInput: accepted(registration as never),
            });
            // 服务端回 503：Process 失败，但已发生的 0.039 美元必须随失败结果返回。
            expect(result).toMatchObject({
                status: "failed",
                cost: { amount: 0.039, source: "provider", complete: true },
            });
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
