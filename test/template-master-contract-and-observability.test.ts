/** 覆盖 template-master/v1 的 sourceRunId 直读、直传兼容松绑、400 结构化响应与控制台可观测性全量验收测试。 */
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createProcessingApplication } from "../src/api/application.js";
import type { CallerIdentityResolver } from "../src/api/identity.js";
import { describeProcessCatalog } from "../src/api/process-catalog.js";
import { createAsyncProcessRuns } from "../src/process-runs/index.js";
import { createInMemoryProcessWorkQueue } from "../src/process-runs/queue/index.js";
import {
    createInMemoryProcessRunStore,
    type StoredProcessRun,
} from "../src/process-runs/store/index.js";
import {
    createProcessWorker,
    createProcessWorkerDrain,
} from "../src/process-runs/worker/index.js";
import {
    createProcessAttemptRunner,
    createProcessRegistry,
    createProcessRunner,
    defineProcessRegistration,
} from "../src/process-runtime/index.js";
import { createProcessRunRecords } from "../src/process-runtime/records.js";
import { draftSchema } from "../src/processes/template-from-image/design-spec/contract.js";
import { createTemplateMasterRegistration } from "../src/processes/template-master/registration.js";
import type { SourceCondition } from "../src/processes/template-master/tier.js";
import {
    createJsonlProcessRunActivityArchive,
    createJsonlProcessRunRecordArchive,
    createJsonlRunObservationStats,
} from "../src/run-observation/jsonl.js";

const fixtureJson = JSON.parse(
    readFileSync(
        new URL("./fixtures/template-v4-candidate.json", import.meta.url),
        "utf8",
    ),
);
const baseTemplate = draftSchema.parse(fixtureJson.draft);
const baseCondition: SourceCondition = {
    marks: [],
    carrier: "flat_artwork",
    sharpness: "clear",
    compressionArtifacts: false,
    notes: [],
};
const imageUrl = "https://assets.example.com/source.png";
const INK = { r: 0x20, g: 0x32, b: 0x4c };

let builtConsoleDir = "";
const runningServices: Array<{ close: () => Promise<void> }> = [];

beforeAll(async () => {
    builtConsoleDir = await mkdtemp(join(tmpdir(), "pipipi-master-console-"));
    await mkdir(join(builtConsoleDir, "assets"));
    await writeFile(
        join(builtConsoleDir, "index.html"),
        "<!doctype html><html><body><div id='console'></div></body></html>",
        "utf8",
    );
});

afterEach(async () => {
    await Promise.all(runningServices.splice(0).map((s) => s.close()));
    vi.useRealTimers();
});

async function paintCleanArtwork(): Promise<Buffer> {
    const size = 400;
    const data = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const inside = Math.hypot(x - 200, y - 200) <= 116;
            const pixel = inside
                ? [INK.r, INK.g, INK.b, 255]
                : [255, 255, 255, 255];
            data.set(pixel, (y * size + x) * 4);
        }
    }
    return sharp(data, { raw: { width: size, height: size, channels: 4 } })
        .png()
        .toBuffer();
}

function fullV3Output() {
    return {
        template: {
            ...baseTemplate,
            status: "DRAFT",
            kind: "PROMPT",
            imageN: 1,
            preprocessSteps: [],
            imageSize: "1024x1024",
            cover: imageUrl,
            referenceImage: imageUrl,
            promptTemplate: "画一张 T 恤印花图案",
            metadata: {
                ...baseTemplate.metadata,
                needsReview: true,
                editablePrompt: true,
                templateSource: "material-box",
            },
        },
        source: {
            texts: [{ text: "LOOK GOOD", elementId: "headline" }],
            condition: baseCondition,
        },
    };
}

async function startHarness(
    options: {
        recordContent?: "omit" | "accepted-input-and-output";
        seededRuns?: readonly StoredProcessRun[];
    } = {},
) {
    const sourcePng = await paintCleanArtwork();
    const recordDir = await mkdtemp(join(tmpdir(), "pipipi-master-obs-"));
    const fixedDate = new Date("2026-11-19T09:16:07.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: fixedDate });
    const archive = createJsonlProcessRunRecordArchive({
        directory: recordDir,
        clock: () => new Date(),
    });
    const activities = createJsonlProcessRunActivityArchive({
        directory: recordDir,
        clock: () => new Date(),
    });
    const stats = createJsonlRunObservationStats({
        directory: recordDir,
        clock: () => new Date(),
    });
    const runRecords = createProcessRunRecords({
        adapter: archive,
        content: options.recordContent ?? "omit",
        clock: () => new Date().toISOString(),
    });

    const edit = vi.fn(async () => sourcePng);
    const upload = vi.fn(async () => ({
        url: `https://assets.memebuy.cn/gallery/template-images/${"b".repeat(64)}.png`,
        sha256: "b".repeat(64),
        width: 400,
        height: 400,
        contentType: "image/png" as const,
    }));
    const verify = vi.fn(async () => ({
        texts: [{ id: "headline", read: "LOOK GOOD" }],
        otherTexts: [],
        layout: { passed: true, offenders: [] },
        watermarkRemaining: false,
    }));

    const templateMaster = createTemplateMasterRegistration({
        capability: { edit, upload },
        verifier: { verify },
        loadSource: async () => sourcePng,
        spentUsd: () => 0,
    });
    const templateFromImage = defineProcessRegistration({
        id: "template-from-image",
        version: "v3",
        inputSchema: z.strictObject({ imageUrl: z.string() }),
        outputSchema: z.unknown(),
        execute: async () => fullV3Output(),
    });
    const otherProcess = defineProcessRegistration({
        id: "minimal-zine-poster",
        version: "v1",
        inputSchema: z.strictObject({ brief: z.string().min(1) }),
        outputSchema: z.strictObject({ ok: z.boolean() }),
        execute: async () => ({ ok: true }),
    });
    const registry = createProcessRegistry([
        templateMaster,
        templateFromImage,
        otherProcess,
    ]);

    const baseStore = createInMemoryProcessRunStore({ maxRuns: 50 });
    const seededMap = new Map<string, StoredProcessRun>(
        (options.seededRuns ?? []).map((r) => [r.runId, r]),
    );
    const store = Object.freeze({
        ...baseStore,
        findOwned: async (runId: string, ownerId: string) => {
            const seeded = seededMap.get(runId);
            if (seeded) return seeded.ownerId === ownerId ? seeded : undefined;
            return baseStore.findOwned(runId, ownerId);
        },
        findById: async (runId: string) =>
            seededMap.get(runId) ?? baseStore.findById?.(runId),
    });

    const sourceRunLookup = async (runId: string) => {
        const found = await store.findById(runId);
        if (found) {
            return {
                runId: found.runId,
                ownerId: found.ownerId,
                process: found.process,
                version: found.version,
                status: found.status,
                ...("resultExpiredAt" in found &&
                found.resultExpiredAt !== undefined
                    ? { resultExpiredAt: found.resultExpiredAt }
                    : {}),
                ...("output" in found && found.output !== undefined
                    ? { output: found.output }
                    : {}),
            };
        }
        const archived = await archive.find(runId);
        if (!archived) return undefined;
        return {
            runId: archived.runId,
            ...(archived.callerId ? { ownerId: archived.callerId } : {}),
            ...(archived.process ? { process: archived.process } : {}),
            ...(archived.version ? { version: archived.version } : {}),
            status: archived.status,
            ...(archived.content?.output !== undefined
                ? { output: archived.content.output }
                : {}),
        };
    };

    const queue = createInMemoryProcessWorkQueue({ maxJobs: 50 });
    let runCounter = 0;
    const runs = createAsyncProcessRuns({
        registry,
        store,
        queue,
        clock: () => new Date().toISOString(),
        createRunId: () =>
            `10000000-0000-4000-8000-${String(++runCounter).padStart(12, "0")}`,
        sourceRunLookup,
    });
    const attemptRunner = createProcessAttemptRunner({
        logSink: activities.record,
    });
    const worker = createProcessWorker({
        registry,
        store,
        attemptRunner,
        runRecords,
        clock: () => new Date().toISOString(),
    });
    const executor = createProcessRunner({
        registry,
        runRecords,
        runLogSink: activities.record,
        sourceRunLookup,
    });

    const logs: unknown[] = [];
    const callerIdentity: CallerIdentityResolver = {
        resolve: async (headers) => {
            const auth = headers.authorization;
            if (typeof auth === "string" && auth.startsWith("Bearer ppk_")) {
                return {
                    callerId: auth.includes("other")
                        ? "other-caller"
                        : "memebuy-uat",
                    authMethod: "api_key" as const,
                };
            }
            const testCaller = headers["x-test-caller"];
            if (typeof testCaller === "string") {
                return {
                    callerId: testCaller,
                    authMethod: "api_key" as const,
                };
            }
            return undefined;
        },
    };

    const application = createProcessingApplication({
        executor,
        http: {
            executeAuthMode: "required",
            callerIdentity,
            logSink: (record) => logs.push(record),
            runRecords,
            asyncProcessRuns: {
                runs,
                callerIdentity,
                readiness: async () => {},
            },
            console: {
                basePath: "/console",
                assetDirectory: builtConsoleDir,
                records: { list: archive.list, find: archive.find },
                activities,
                processes: describeProcessCatalog(registry),
                stats: { summarise: stats.summarise },
            },
        },
    });
    runningServices.push(application);
    const { url } = await application.listen();
    return {
        url,
        store,
        queue,
        drain: createProcessWorkerDrain({ source: queue, worker }),
        logs,
        activities,
        archive,
        verify,
        upload,
        edit,
    };
}

function seededSourceRun(
    overrides: Partial<StoredProcessRun> & { runId: string },
): StoredProcessRun {
    const base = {
        schemaVersion: 1 as const,
        ownerId: "memebuy-uat",
        idempotencyKey: `idem-${overrides.runId}`,
        requestFingerprint: "fp",
        process: "template-from-image",
        version: "v3",
        createdAt: "2026-11-19T09:15:43.000Z",
        updatedAt: "2026-11-19T09:15:50.000Z",
        startedAt: "2026-11-19T09:15:44.000Z",
        finishedAt: "2026-11-19T09:15:50.000Z",
        attemptCount: 1,
        revision: 2,
        status: "succeeded" as const,
        output: fullV3Output(),
    };
    return { ...base, ...overrides } as StoredProcessRun;
}

describe("template-master/v1 契约治理与 400 可观测性", () => {
    it("AC-1 & AC-2：通过 sourceRunId 直读上游产物完整跑通母版，并在控制台记录可溯源 sourceRunId", async () => {
        const sourceRunId = "bdf8bd32-4349-4c6f-abe1-b4bb514339a9";
        const h = await startHarness({
            recordContent: "omit",
            seededRuns: [seededSourceRun({ runId: sourceRunId })],
        });

        const submitRes = await fetch(`${h.url}/process-runs`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-test-caller": "memebuy-uat",
                "idempotency-key": "master-source-run-1",
            },
            body: JSON.stringify({
                process: "template-master",
                version: "v1",
                input: {
                    imageUrl,
                    sourceRunId,
                    budget: { maxAttempts: 5, maxUsd: 1 },
                },
            }),
        });
        expect(submitRes.status).toBe(202);
        const accepted = (await submitRes.json()) as { runId: string };
        expect(accepted.runId).toBeTruthy();

        await expect(h.drain.drainOne()).resolves.toBe("processed");
        await h.activities.flush();

        const runRes = await fetch(`${h.url}/process-runs/${accepted.runId}`, {
            headers: { "x-test-caller": "memebuy-uat" },
        });
        expect(runRes.status).toBe(200);
        const runView = (await runRes.json()) as {
            status: string;
            output: { master: { tier: string } };
        };
        expect(runView.status).toBe("succeeded");
        expect(runView.output.master.tier).toBe("light");

        // 控制台运行记录即使关闭 content 正文，仍携带 callerId 与 sourceRunId 供回溯
        const consoleRunRes = await fetch(
            `${h.url}/console/runs/${accepted.runId}`,
        );
        expect(consoleRunRes.status).toBe(200);
        const consoleRecord = await consoleRunRes.json();
        expect(consoleRecord).toMatchObject({
            runId: accepted.runId,
            process: "template-master",
            version: "v1",
            callerId: "memebuy-uat",
            sourceRunId,
            status: "succeeded",
        });

        const timelineRes = await fetch(
            `${h.url}/console/runs/${accepted.runId}/activities`,
        );
        const timeline = (await timelineRes.json()) as {
            activities: Array<{ activity?: string }>;
        };
        const executedActivities = timeline.activities
            .map((a) => a.activity)
            .filter(Boolean);
        expect(executedActivities).toContain("master_source_loading");
        expect(executedActivities).toContain("master_light_rendering");
        expect(executedActivities).toContain("master_verification");
        expect(executedActivities).toContain("master_upload");
    });

    it("AC-3：拦截越权、不存在、非解析流程、未成功、已过期、缺 condition 以及二选一冲突的 sourceRunId", async () => {
        const ownedV3 = "00000000-0000-4000-8000-000000000001";
        const otherCallerRun = "00000000-0000-4000-8000-000000000002";
        const wrongProcessRun = "00000000-0000-4000-8000-000000000003";
        const runningRun = "00000000-0000-4000-8000-000000000004";
        const failedRun = "00000000-0000-4000-8000-000000000005";
        const expiredRun = "00000000-0000-4000-8000-000000000006";
        const v1NoConditionRun = "00000000-0000-4000-8000-000000000007";

        const h = await startHarness({
            seededRuns: [
                seededSourceRun({ runId: ownedV3 }),
                seededSourceRun({
                    runId: otherCallerRun,
                    ownerId: "other-caller",
                }),
                seededSourceRun({
                    runId: wrongProcessRun,
                    process: "minimal-zine-poster",
                    version: "v1",
                    output: { ok: true },
                }),
                {
                    schemaVersion: 1,
                    runId: runningRun,
                    ownerId: "memebuy-uat",
                    idempotencyKey: "k-running",
                    requestFingerprint: "fp",
                    process: "template-from-image",
                    version: "v3",
                    status: "running",
                    acceptedInput: {
                        schemaVersion: 1,
                        process: "template-from-image",
                        version: "v3",
                        input: { imageUrl },
                    },
                    claimToken: "claim-1",
                    claimExpiresAt: "2026-11-19T10:00:00.000Z",
                    createdAt: "2026-11-19T09:15:00.000Z",
                    startedAt: "2026-11-19T09:15:01.000Z",
                    updatedAt: "2026-11-19T09:15:01.000Z",
                    attemptCount: 1,
                    revision: 1,
                },
                {
                    schemaVersion: 1,
                    runId: failedRun,
                    ownerId: "memebuy-uat",
                    idempotencyKey: "k-failed",
                    requestFingerprint: "fp",
                    process: "template-from-image",
                    version: "v3",
                    status: "failed",
                    createdAt: "2026-11-19T09:15:00.000Z",
                    startedAt: "2026-11-19T09:15:01.000Z",
                    finishedAt: "2026-11-19T09:15:02.000Z",
                    updatedAt: "2026-11-19T09:15:02.000Z",
                    attemptCount: 1,
                    revision: 2,
                    error: { code: "AGENT_FAILURE", message: "failed" },
                },
                {
                    schemaVersion: 1,
                    runId: expiredRun,
                    ownerId: "memebuy-uat",
                    idempotencyKey: "k-expired",
                    requestFingerprint: "fp",
                    process: "template-from-image",
                    version: "v3",
                    status: "succeeded",
                    createdAt: "2026-11-10T09:15:00.000Z",
                    startedAt: "2026-11-10T09:15:01.000Z",
                    finishedAt: "2026-11-10T09:15:02.000Z",
                    updatedAt: "2026-11-10T09:15:02.000Z",
                    attemptCount: 1,
                    revision: 2,
                    resultExpiredAt: "2026-11-17T09:15:02.000Z",
                },
                seededSourceRun({
                    runId: v1NoConditionRun,
                    version: "v1",
                    output: { template: baseTemplate },
                }),
            ],
        });

        const post = (input: unknown, key: string) =>
            fetch(`${h.url}/process-runs`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-test-caller": "memebuy-uat",
                    "idempotency-key": key,
                },
                body: JSON.stringify({
                    process: "template-master",
                    version: "v1",
                    input,
                }),
            });

        const budget = { maxAttempts: 5, maxUsd: 1 };

        const cases: Array<[string, unknown, string]> = [
            [
                "跨 caller 越权引用",
                { imageUrl, sourceRunId: otherCallerRun, budget },
                "SOURCE_RUN_FORBIDDEN",
            ],
            [
                "不存在的 sourceRunId",
                {
                    imageUrl,
                    sourceRunId: "99999999-9999-4000-8000-999999999999",
                    budget,
                },
                "SOURCE_RUN_NOT_FOUND",
            ],
            [
                "非 template-from-image 流程",
                { imageUrl, sourceRunId: wrongProcessRun, budget },
                "SOURCE_RUN_INVALID_PROCESS",
            ],
            [
                "仍在运行中",
                { imageUrl, sourceRunId: runningRun, budget },
                "SOURCE_RUN_NOT_READY",
            ],
            [
                "已失败的上游运行",
                { imageUrl, sourceRunId: failedRun, budget },
                "SOURCE_RUN_NOT_READY",
            ],
            [
                "产物已过期",
                { imageUrl, sourceRunId: expiredRun, budget },
                "SOURCE_RUN_EXPIRED",
            ],
            [
                "缺少 source.condition",
                { imageUrl, sourceRunId: v1NoConditionRun, budget },
                "SOURCE_RUN_MISSING_CONDITION",
            ],
            [
                "同时传 sourceRunId 与 template",
                {
                    imageUrl,
                    sourceRunId: ownedV3,
                    template: baseTemplate,
                    condition: baseCondition,
                    budget,
                },
                "INVALID_INPUT",
            ],
            ["两者都不传", { imageUrl, budget }, "INVALID_INPUT"],
        ];

        for (const [index, [label, input, expectedCode]] of cases.entries()) {
            const res = await post(input, `ac3-key-${index}`);
            expect(res.status, label).toBe(400);
            const body = (await res.json()) as {
                error: { code: string; message: string; details?: unknown[] };
            };
            expect(body.error.code, label).toBe(expectedCode);
            expect(body.error.details?.length, label).toBeGreaterThan(0);
        }

        // 所有拦截均在入队前发生，队列必须为空
        await expect(h.queue.take()).resolves.toBeUndefined();
    });

    it("AC-4, AC-5, AC-6, AC-7：旧直传模式兼容上游完整产物、6 字段与边界值，同时拦截缺核心必填项", async () => {
        const h = await startHarness();
        const post = (input: unknown, key: string) =>
            fetch(`${h.url}/process-runs`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-test-caller": "memebuy-uat",
                    "idempotency-key": key,
                },
                body: JSON.stringify({
                    process: "template-master",
                    version: "v1",
                    input,
                }),
            });

        const budget = { maxAttempts: 5, maxUsd: 1 };
        const full = fullV3Output();

        // AC-4: 原样透传 template-from-image/v3 完整输出 + 业务字段
        expect(
            (
                await post(
                    {
                        imageUrl,
                        template: full.template,
                        condition: full.source.condition,
                        budget,
                    },
                    "ac4",
                )
            ).status,
        ).toBe(202);

        // AC-5: 精简 6 字段
        expect(
            (
                await post(
                    {
                        imageUrl,
                        template: baseTemplate,
                        condition: baseCondition,
                        budget,
                    },
                    "ac5",
                )
            ).status,
        ).toBe(202);

        // AC-6: 标题 21-80 字、description null/""/21-300 字、缺 metadata、tags 0/3/10 条或单条 > 12 字
        const { metadata: _omitMeta, ...withoutMeta } = baseTemplate;
        for (const [key, patchedTemplate] of [
            [
                "ac6-title-80",
                {
                    ...baseTemplate,
                    title: "超长合法上游标题测试".repeat(8),
                },
            ],
            ["ac6-desc-null", { ...baseTemplate, description: null }],
            ["ac6-desc-empty", { ...baseTemplate, description: "" }],
            [
                "ac6-desc-300",
                { ...baseTemplate, description: "合法长描述".repeat(60) },
            ],
            ["ac6-no-meta", withoutMeta],
            ["ac6-tags-0", { ...baseTemplate, metadata: { tags: [] } }],
            [
                "ac6-tags-3",
                { ...baseTemplate, metadata: { tags: ["一", "二", "三"] } },
            ],
            [
                "ac6-tags-10-long",
                {
                    ...baseTemplate,
                    metadata: {
                        tags: Array.from(
                            { length: 10 },
                            (_, i) => `超过十二个字符的长标签名称_${i}`,
                        ),
                    },
                },
            ],
        ] as const) {
            const res = await post(
                {
                    imageUrl,
                    template: patchedTemplate,
                    condition: baseCondition,
                    budget,
                },
                key,
            );
            expect(res.status, key).toBe(202);
        }

        // AC-7: 缺核心必填字段仍返回 400 INVALID_INPUT
        const { runtimeSemantics: _omitSem, ...noRuntimeSemantics } =
            baseTemplate;
        for (const [key, badInput] of [
            [
                "ac7-no-image",
                { template: baseTemplate, condition: baseCondition, budget },
            ],
            ["ac7-no-condition", { imageUrl, template: baseTemplate, budget }],
            [
                "ac7-no-budget",
                { imageUrl, template: baseTemplate, condition: baseCondition },
            ],
            [
                "ac7-no-runtimeSemantics",
                {
                    imageUrl,
                    template: noRuntimeSemantics,
                    condition: baseCondition,
                    budget,
                },
            ],
        ] as const) {
            const res = await post(badInput, key);
            expect(res.status, key).toBe(400);
            expect(await res.json()).toMatchObject({
                error: { code: "INVALID_INPUT" },
            });
        }
    });

    it("AC-8, AC-9, AC-10, AC-11：400 精确到字段、控制台异常排查可见无 unknown/unknown、严格脱敏且不占幂等键", async () => {
        const h = await startHarness({
            recordContent: "accepted-input-and-output",
        });
        const signedImageUrl =
            "https://assets.example.com/private/photo.png?OSSAccessKeyId=LTAI5tSecretKeyId&Expires=1795000000&Signature=SuperSecretOssSignature%3D";
        const bearerToken =
            "ppk_62ebf3a3_SuperSecretApiKeyValue12345678901234567890123";
        const idempotencyKey = "memebuy-master-idem-001";
        const traceId = "trace-memebuy-400-01";

        // 1. 先发送缺 budget 且带签名 URL 和 Bearer Token 的非法请求
        const badRes = await fetch(`${h.url}/process-runs`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${bearerToken}`,
                "idempotency-key": idempotencyKey,
                "x-request-id": traceId,
            },
            body: JSON.stringify({
                process: "template-master",
                version: "v1",
                input: {
                    imageUrl: signedImageUrl,
                    template: baseTemplate,
                    condition: baseCondition,
                },
            }),
        });

        expect(badRes.status).toBe(400);
        const badBody = (await badRes.json()) as {
            error: {
                code: string;
                message: string;
                details: Array<{
                    path: string;
                    keyword: string;
                    message: string;
                }>;
            };
        };
        // AC-8: 精确列出失败字段路径 /budget
        expect(badBody.error.code).toBe("INVALID_INPUT");
        expect(badBody.error.message).toContain("template-master/v1");
        expect(badBody.error.message).toContain("/budget");
        expect(badBody.error.details).toContainEqual(
            expect.objectContaining({
                path: "/budget",
                keyword: "required",
            }),
        );

        // AC-9: 控制台「异常排查」（/console/stats）与「运行记录」（/console/runs）立即查到，无 unknown/unknown
        // 统计窗口的上界不包含当前毫秒。
        vi.setSystemTime(Date.now() + 1);
        const statsRes = await fetch(`${h.url}/console/stats?hours=24`);
        expect(statsRes.status).toBe(200);
        const statsBody = await statsRes.json();
        expect(statsBody.failures).toContainEqual(
            expect.objectContaining({
                process: "template-master",
                version: "v1",
                errorCode: "INVALID_INPUT",
                count: 1,
            }),
        );
        expect(statsBody.recentFailures[0]).toMatchObject({
            process: "template-master",
            version: "v1",
            errorCode: "INVALID_INPUT",
            callerId: "memebuy-uat",
            failureDetail: {
                httpStatus: 400,
                endpoint: "/process-runs",
                idempotencyKey,
                traceId,
                details: [expect.objectContaining({ path: "/budget" })],
            },
        });

        const runsRes = await fetch(
            `${h.url}/console/runs?process=template-master&version=v1&status=failed&errorCode=INVALID_INPUT`,
        );
        const runsBody = (await runsRes.json()) as {
            records: Array<{ runId: string }>;
        };
        expect(runsBody.records).toHaveLength(1);
        const detailRes = await fetch(
            `${h.url}/console/runs/${runsBody.records[0]?.runId}`,
        );
        const detailBody = await detailRes.json();
        expect(detailBody).toMatchObject({
            callerId: "memebuy-uat",
            process: "template-master",
            version: "v1",
            errorCode: "INVALID_INPUT",
            failureDetail: {
                httpStatus: 400,
                endpoint: "/process-runs",
                idempotencyKey,
                traceId,
            },
        });
        expect(detailBody).not.toHaveProperty("content");

        // AC-10: 响应体、服务端日志与控制台页面严禁泄露签名 query 参数与 Bearer Token
        const combinedArtifacts = JSON.stringify({
            badBody,
            logs: h.logs,
            statsBody,
            runsBody,
            detailBody,
        });
        for (const secret of [
            "OSSAccessKeyId",
            "LTAI5tSecretKeyId",
            "Signature",
            "SuperSecretOssSignature",
            "Expires=1795000000",
            "ppk_62ebf3a3",
            "SuperSecretApiKeyValue",
        ]) {
            expect(combinedArtifacts).not.toContain(secret);
        }

        // AC-11: 修正参数后复用同一 Idempotency-Key 必须返回 202（不得返回 409）
        const fixedRes = await fetch(`${h.url}/process-runs`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${bearerToken}`,
                "idempotency-key": idempotencyKey,
            },
            body: JSON.stringify({
                process: "template-master",
                version: "v1",
                input: {
                    imageUrl: signedImageUrl,
                    template: baseTemplate,
                    condition: baseCondition,
                    budget: { maxAttempts: 5, maxUsd: 1 },
                },
            }),
        });
        expect(fixedRes.status).toBe(202);
        const fixedAccepted = (await fixedRes.json()) as { runId: string };

        // 跑通后控制台归档的正文里 imageUrl 也剥离了签名 query 参数
        await expect(h.drain.drainOne()).resolves.toBe("processed");
        const completedDetail = await (
            await fetch(`${h.url}/console/runs/${fixedAccepted.runId}`)
        ).json();
        expect(completedDetail.content.input.imageUrl).toBe(
            "https://assets.example.com/private/photo.png",
        );
        expect(JSON.stringify(completedDetail)).not.toContain(
            "SuperSecretOssSignature",
        );
    });

    it("AC-9 补充：/execute 缺失部分信封字段时独立保留已解析的 process，不退化为 unknown/unknown", async () => {
        const h = await startHarness();
        const res = await fetch(`${h.url}/execute`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-test-caller": "memebuy-uat",
                "x-request-id": "exec-partial-1",
            },
            body: JSON.stringify({
                process: "template-master",
                input: {},
            }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as {
            runId: string;
            process?: string;
            error: { code: string; details: Array<{ path: string }> };
        };
        expect(body.process).toBe("template-master");
        expect(body.error.code).toBe("INVALID_INPUT");
        expect(body.error.details).toContainEqual(
            expect.objectContaining({ path: "/version" }),
        );

        const stored = await (
            await fetch(`${h.url}/console/runs/${body.runId}`)
        ).json();
        expect(stored.process).toBe("template-master");
        expect(stored.callerId).toBe("memebuy-uat");
        expect(stored.failureDetail.traceId).toBe("exec-partial-1");
    });

    it("AC-12：/console/processes 导出的 template-master/v1 输入 Schema 同步体现 sourceRunId 与松绑后的直传模式", async () => {
        const h = await startHarness();
        const res = await fetch(`${h.url}/console/processes`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            processes: Array<{
                process: string;
                version: string;
                input?: {
                    anyOf?: Array<{
                        required?: string[];
                        properties?: Record<string, Record<string, unknown>>;
                    }>;
                };
            }>;
        };
        const master = body.processes.find(
            (p) => p.process === "template-master" && p.version === "v1",
        );
        expect(master?.input?.anyOf).toHaveLength(2);
        const branches = master?.input?.anyOf ?? [];
        const sourceRunBranch = branches.find((b) =>
            b.required?.includes("sourceRunId"),
        );
        const directBranch = branches.find((b) =>
            b.required?.includes("template"),
        );
        expect(sourceRunBranch?.required).toEqual(
            expect.arrayContaining(["imageUrl", "sourceRunId", "budget"]),
        );
        expect(directBranch?.required).toEqual(
            expect.arrayContaining([
                "imageUrl",
                "template",
                "condition",
                "budget",
            ]),
        );
        const templateSchema = directBranch?.properties?.template as
            | {
                  additionalProperties?: boolean;
                  properties?: Record<string, Record<string, unknown>>;
              }
            | undefined;
        expect(templateSchema?.additionalProperties).toBeUndefined();
        expect(templateSchema?.properties?.title).toMatchObject({
            minLength: 1,
            maxLength: 80,
        });
        expect(
            (
                templateSchema?.properties?.metadata as
                    | { additionalProperties?: boolean }
                    | undefined
            )?.additionalProperties,
        ).toBeUndefined();
    });
});
