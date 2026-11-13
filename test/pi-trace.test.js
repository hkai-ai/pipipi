import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { expect, it, vi } from "vitest";
import { constructProcessingService } from "../src/app/api.ts";
import { createProductionRuntime } from "../src/app/business-processes.ts";
import {
    combineProcessRunLogSinks,
    createProcessAttemptRunner,
} from "../src/process-runtime/index.ts";
import { startDemoGateway } from "./fixtures/pi-trace-gateway.mjs";
import { chromeExecutable } from "./support/chrome.js";

const fixtures = JSON.parse(
    await readFile(
        new URL("./fixtures/character-emoji-v4.json", import.meta.url),
        "utf8",
    ),
);
const fixture = fixtures.single;
it.each([
    ["漫画模式创作", fixtures.comic.request.input.idea, false, [], "comic"],
    ["海报无工具流程", "", false, [], "poster"],
    ["普通创作", "雨狐给云撑伞", false, []],
    ["允许但跳过搜索", "请联网搜梗，画雨狐给云撑伞", false, ["search_memes"]],
    ["修正不通过停止生图", "雨狐给云撑伞", false, [], "repair-rejected"],
    ["字段修正后生图", "雨狐给云撑伞", false, [], "repair"],
    [
        "搜索失败转原创",
        "请联网搜梗，画雨狐给云撑伞",
        true,
        ["search_memes"],
        "search-failure",
    ],
    [
        "可用搜索材料",
        "请联网搜梗，画雨狐给云撑伞",
        true,
        ["search_memes"],
        "usable",
    ],
    [
        "未核验搜索材料",
        "请联网搜梗，画雨狐给云撑伞",
        true,
        ["search_memes"],
        "unverifiable",
    ],
    ["实际搜索后继续", "请联网搜梗，画雨狐给云撑伞", true, ["search_memes"]],
])(
    "通过同步业务入口查看%s的真实 Pi 执行轨迹",
    async (_title, idea, useSearch, tools, scenario) => {
        const fixture = scenario === "comic" ? fixtures.comic : fixtures.single;
        const archive = await mkdtemp(join(tmpdir(), "pi-trace-"));
        const gateway = await startDemoGateway(fixture, useSearch, {
            scenario,
        });
        const fetcher = globalThis.fetch;
        vi.stubGlobal("fetch", (url, init) => {
            if (
                fixture.request.input.cast.some(
                    (member) => member.referenceImageUrl === String(url),
                ) &&
                init?.method === "HEAD"
            )
                return Promise.resolve(new Response(null));
            if (!String(url).startsWith("http://127.0.0.1:"))
                throw new Error("unexpected external request");
            return fetcher(url, init);
        });
        const { application } = constructProcessingService({
            OPENAI_API_MODE: "responses",
            PI_PROVIDER: "openai",
            PI_MODEL: "gpt-5.4",
            MODEL_GATEWAY_BASE_URL: `${gateway.url}/v1`,
            MODEL_GATEWAY_API_KEY: "offline-secret",
            CRT_BUSINESS_API_BASE_URL: gateway.url,
            CONSOLE_ENABLED: "true",
            CONSOLE_ASSET_DIRECTORY: resolve("dist/console"),
            PROCESS_RUN_RECORD_DIRECTORY: archive,
            PROCESS_RUN_RECORD_CONTENT: "omit",
            PROCESS_RUN_LOG_LEVEL: "silent",
        });
        try {
            const { url } = await application.listen();
            const response = await fetch(`${url}/execute`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(
                    scenario === "poster"
                        ? {
                              process: "minimal-zine-poster",
                              version: "v1",
                              input: { brief: "雨后的小书店" },
                          }
                        : {
                              ...fixture.request,
                              input: { ...fixture.request.input, idea },
                          },
                ),
            });
            const result = await response.json();
            const rejected = scenario === "repair-rejected";
            expect(result.status).toBe(rejected ? "failed" : "succeeded");
            expect(gateway.counts).toEqual({
                plan: useSearch || scenario === "repair" || rejected ? 2 : 1,
                search: Number(useSearch),
                render: rejected ? 0 : 1,
            });
            const readTimeline = async () =>
                (
                    await (
                        await fetch(
                            url +
                                "/console/runs/" +
                                result.runId +
                                "/activities",
                        )
                    ).json()
                ).activities;
            await vi.waitFor(async () =>
                expect((await readTimeline()).at(-1)?.event).toBe(
                    "process_run_attempt_finished",
                ),
            );
            const activities = await readTimeline();
            const planning = activities.find(
                (e) =>
                    e.event === "process_run_activity_finished" &&
                    e.activity ===
                        (scenario === "poster"
                            ? "poster_prompt_compilation"
                            : "character_emoji_planning"),
            );
            expect(planning?.sessions).toHaveLength(1);
            const session = planning.sessions[0];
            if (rejected) {
                expect(result.error.code).toBe("AGENT_FAILURE");
                expect(session.validation).toBe("failed");
                expect(
                    session.rounds.map((r) => r.decisions?.map((d) => d.kind)),
                ).toEqual([
                    ["validation_failed", "repair_started"],
                    ["validation_failed"],
                ]);
                expect(
                    activities.some(
                        (e) => e.activity === "character_emoji_rendering",
                    ),
                ).toBe(false);
                return;
            }
            if (scenario === "poster") {
                expect(session.skills).toEqual([
                    { name: "minimal-zine-poster-prompt", version: "v1" },
                ]);
                expect(session.rounds).toMatchObject([
                    {
                        model: "gpt-5.4",
                        tools: [],
                        calls: [],
                        outcome: "stop",
                        usage: { input: 50, output: 20 },
                    },
                ]);
                if (process.env.RUN_CONSOLE_OBSERVATION_BROWSER === "1") {
                    const browser = await chromium.launch({
                        executablePath: await chromeExecutable(),
                    });
                    try {
                        const page = await browser.newPage();
                        await page.goto(`${url}/console/#/run/${result.runId}`);
                        await page
                            .getByText("Pi 会话 1", { exact: true })
                            .click();
                        await page
                            .getByText("minimal-zine-poster-prompt · v1")
                            .waitFor();
                        await page
                            .getByText("未开放工具", { exact: true })
                            .waitFor();
                    } finally {
                        await browser.close();
                    }
                }
                return;
            }
            expect(session.skills.map((s) => s.name)).toEqual([
                "character-emoji-planner",
                scenario === "comic"
                    ? "character-emoji-comic"
                    : "character-emoji-single",
            ]);
            expect(session.skills.every((s) => s.version)).toBe(true);
            expect(session.validation).toBe("passed");
            expect(session.rounds).toHaveLength(gateway.counts.plan);
            expect(session.rounds[0].tools).toEqual(tools);
            if (scenario === "repair") {
                expect(session.rounds.map((r) => r.decisions)).toEqual([
                    [
                        {
                            kind: "validation_failed",
                            reason: "business_validation",
                            issues: [
                                {
                                    path: "caption",
                                    code: "caption_setting_mismatch",
                                },
                            ],
                        },
                        { kind: "repair_started" },
                    ],
                    [{ kind: "validation_passed" }],
                ]);
                expect(
                    activities.find(
                        (e) =>
                            e.event === "process_run_activity_started" &&
                            e.activity === "character_emoji_rendering",
                    ).sequence,
                ).toBeGreaterThan(planning.sequence);
            }
            if (scenario === "search-failure") {
                expect(session.rounds[0].decisions).toEqual([
                    {
                        kind: "search_failed",
                        reason: "http_error",
                        httpStatus: 503,
                        call: 1,
                    },
                    { kind: "original_fallback", call: 1 },
                ]);
            }
            if (useSearch && scenario !== "search-failure") {
                expect(session.rounds[0].decisions).toContainEqual({
                    kind: "search_result",
                    material: scenario ?? "insufficient",
                    call: 1,
                });
            }
            const rendered = activities.find(
                (e) =>
                    e.event === "process_run_activity_finished" &&
                    e.activity === "character_emoji_rendering",
            );
            expect(rendered.sessions).toEqual([]);
            if (useSearch) {
                expect(session.rounds[0]).toMatchObject({
                    calls: [
                        {
                            call: 1,
                            name: "search_memes",
                            result: "returned",
                            durationMs: expect.any(Number),
                        },
                    ],
                    outcome: "toolUse",
                    usage: { input: 180, output: 18 },
                });
                expect(session.rounds[1].tools).toEqual([]);
            } else expect(session.rounds[0].calls).toEqual([]);
            expect(session.rounds.at(-1)).toMatchObject({
                outcome: "stop",
                durationMs: expect.any(Number),
                usage: { input: 215, output: 42 },
            });
            for (const secret of [
                "仅供检索的私密探针-417",
                "private-source-417",
                idea,
                "offline-secret",
                "call_demo",
                "本地演示无可引用",
            ])
                expect(JSON.stringify(activities)).not.toContain(secret);
            if (process.env.RUN_CONSOLE_OBSERVATION_BROWSER === "1") {
                const browser = await chromium.launch({
                    executablePath: await chromeExecutable(),
                });
                try {
                    const page = await browser.newPage();
                    await page.goto(`${url}/console/#/run/${result.runId}`);
                    await page.getByText("Pi 会话 1", { exact: true }).click();
                    await page.getByText("最终业务校验通过").waitFor();
                    await page
                        .getByText("本次活动没有 Pi 会话", { exact: true })
                        .waitFor();
                    await page
                        .getByText(
                            scenario === "comic"
                                ? "character-emoji-comic · v6"
                                : "character-emoji-single · v4",
                            { exact: true },
                        )
                        .waitFor();
                    if (useSearch && scenario !== "search-failure")
                        await page
                            .getByText(
                                scenario === "usable"
                                    ? /搜索材料.*可用/
                                    : scenario === "unverifiable"
                                      ? /搜索材料.*未核验/
                                      : /搜索材料.*不足/,
                            )
                            .waitFor();
                    if (scenario === "repair") {
                        await page
                            .getByText(/校验失败.*caption_setting_mismatch/)
                            .waitFor();
                        await page
                            .getByText("开始修正", { exact: true })
                            .waitFor();
                    }
                    if (scenario === "search-failure") {
                        await page
                            .getByText(/联网搜索失败.*HTTP 503/)
                            .waitFor();
                        await page.getByText(/改用原创.*调用 1/).waitFor();
                    }
                    await page
                        .getByText(
                            useSearch
                                ? "工具返回成功"
                                : tools.length
                                  ? "未调用"
                                  : "未开放工具",
                            { exact: false },
                        )
                        .first()
                        .waitFor();
                } finally {
                    await browser.close();
                }
            }
        } finally {
            vi.unstubAllGlobals();
            await application.close();
            await gateway.close();
            await rm(archive, { recursive: true, force: true, maxRetries: 3 });
        }
    },
    30_000,
);

it.each(["cancel", "sink-fault"])(
    "Worker Attempt %s preserves terminal state, model budget and image dispatch",
    async (mode) => {
        const entered = Promise.withResolvers();
        const release = Promise.withResolvers();
        const gateway = await startDemoGateway(
            fixture,
            false,
            mode === "cancel"
                ? {
                      beforePlan: async () => {
                          entered.resolve();
                          await release.promise;
                      },
                  }
                : {},
        );
        const fetcher = globalThis.fetch;
        vi.stubGlobal("fetch", (url, init) => {
            if (
                String(url) ===
                    fixture.request.input.cast[0].referenceImageUrl &&
                init?.method === "HEAD"
            )
                return Promise.resolve(new Response(null));
            if (!String(url).startsWith("http://127.0.0.1:"))
                throw new Error("unexpected outbound request");
            return fetcher(url, init);
        });
        try {
            const runtime = createProductionRuntime({
                PI_PROVIDER: "openai",
                PI_MODEL: "gpt-5.4",
                MODEL_GATEWAY_BASE_URL: `${gateway.url}/v1`,
                MODEL_GATEWAY_API_KEY: "offline-secret",
                CRT_BUSINESS_API_BASE_URL: gateway.url,
            });
            const registration = runtime.registry.find({
                id: "character-emoji",
                version: "v4",
            });
            const acceptance = registration.accept({
                ...fixture.request.input,
                idea: "雨狐给云撑伞",
            });
            expect(acceptance.accepted).toBe(true);
            const records = [];
            const controller = new AbortController();
            const sink = (r) => records.push(r);
            const runner = createProcessAttemptRunner({
                logSink:
                    mode === "sink-fault"
                        ? combineProcessRunLogSinks(() => {
                              throw new Error("private sink failure");
                          }, sink)
                        : sink,
            });
            const resultPromise = runner.run({
                runId: "63d65ec7-6c56-43a9-bd49-287567a81e8d",
                attemptNumber: 2,
                registration,
                acceptedInput: acceptance.acceptedInput,
                signal: controller.signal,
            });
            if (mode === "cancel") {
                await entered.promise;
                controller.abort();
                release.resolve();
            }
            const result = await resultPromise;
            expect(result.status).toBe(
                mode === "cancel" ? "failed" : "succeeded",
            );
            expect(records.at(-1)).toMatchObject({
                event: "process_run_attempt_finished",
                outcome: mode === "cancel" ? "cancelled" : "succeeded",
                attemptNumber: 2,
            });
            const planning = records.find(
                (r) =>
                    r.event === "process_run_activity_finished" &&
                    r.activity === "character_emoji_planning",
            );
            expect(planning.sessions[0].rounds).toHaveLength(1);
            if (mode === "cancel") {
                expect(planning.outcome).toBe("cancelled");
                expect(planning.sessions[0].rounds[0].decisions).toContainEqual(
                    { kind: "cancelled", reason: "cancelled" },
                );
            }
            expect(gateway.counts).toEqual({
                plan: 1,
                search: 0,
                render: mode === "cancel" ? 0 : 1,
            });
            expect(JSON.stringify(records)).not.toContain(
                "private sink failure",
            );
        } finally {
            release.resolve();
            vi.unstubAllGlobals();
            await gateway.close();
        }
    },
    30_000,
);
