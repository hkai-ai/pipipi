import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { expect, it, vi } from "vitest";
import { constructProcessingService } from "../src/app/api.ts";
import { startDemoGateway } from "./fixtures/pi-trace-gateway.mjs";

const fixture = JSON.parse(
    await readFile(
        new URL("./fixtures/character-emoji-v4.json", import.meta.url),
        "utf8",
    ),
).single;
it.each([
    ["普通创作", "雨狐给云撑伞", false, []],
    ["允许但跳过搜索", "请联网搜梗，画雨狐给云撑伞", false, ["search_memes"]],
    ["实际搜索后继续", "请联网搜梗，画雨狐给云撑伞", true, ["search_memes"]],
])(
    "通过同步业务入口查看%s的真实 Pi 执行轨迹",
    async (_title, idea, useSearch, tools) => {
        const archive = await mkdtemp(join(tmpdir(), "pi-trace-"));
        const gateway = await startDemoGateway(fixture, useSearch);
        const fetcher = globalThis.fetch;
        vi.stubGlobal("fetch", (url, init) => {
            if (
                String(url) ===
                    fixture.request.input.cast[0].referenceImageUrl &&
                init?.method === "HEAD"
            )
                return Promise.resolve(new Response(null));
            if (!String(url).startsWith("http://127.0.0.1:"))
                throw new Error("unexpected external request");
            return fetcher(url, init);
        });
        const { application } = constructProcessingService({
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
                body: JSON.stringify({
                    ...fixture.request,
                    input: { ...fixture.request.input, idea },
                }),
            });
            const result = await response.json();
            expect(result.status).toBe("succeeded");
            expect(gateway.counts).toEqual({
                plan: useSearch ? 2 : 1,
                search: Number(useSearch),
                render: 1,
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
                    e.activity === "character_emoji_planning",
            );
            expect(planning?.sessions).toHaveLength(1);
            const session = planning.sessions[0];
            expect(session.skills.map((s) => s.name)).toEqual([
                "character-emoji-planner",
                "character-emoji-single",
            ]);
            expect(session.skills.every((s) => s.version)).toBe(true);
            expect(session.validation).toBe("passed");
            expect(session.rounds).toHaveLength(gateway.counts.plan);
            expect(session.rounds[0].tools).toEqual(tools);
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
                idea,
                "offline-secret",
                "call_demo",
                "本地演示无可引用",
            ])
                expect(JSON.stringify(activities)).not.toContain(secret);
            if (process.env.RUN_CONSOLE_OBSERVATION_BROWSER === "1") {
                const browser = await chromium.launch({
                    executablePath:
                        process.env.CHROME_PATH ??
                        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                });
                try {
                    const page = await browser.newPage();
                    await page.goto(`${url}/console/#/run/${result.runId}`);
                    await page.getByText("Pi 会话 1", { exact: true }).click();
                    await page.getByText("最终业务校验通过").waitFor();
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
            await rm(archive, { recursive: true, force: true });
        }
    },
    30_000,
);
