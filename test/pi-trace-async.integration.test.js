import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { startDemoGateway } from "./fixtures/pi-trace-gateway.mjs";
import { startConsoleAsyncAcceptanceEnvironment } from "./support/console-async-acceptance-environment.js";

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_TEST_URL;
it.skipIf(!databaseUrl || !redisUrl)(
    "同一运行从排队到独立 Worker 执行结束均可用原 runId 查看",
    async () => {
        const fixture = JSON.parse(
            await readFile(
                new URL("./fixtures/character-emoji-v4.json", import.meta.url),
                "utf8",
            ),
        ).single;
        const rendering = Promise.withResolvers();
        const gateway = await startDemoGateway(fixture, true, {
            beforeRender: () => rendering.promise,
        });
        const nativeFetch = globalThis.fetch;
        vi.stubGlobal("fetch", (url, init) => {
            if (
                String(url) ===
                    fixture.request.input.cast[0].referenceImageUrl &&
                init?.method === "HEAD"
            )
                return Promise.resolve(new Response(null));
            if (!String(url).startsWith("http://127.0.0.1:"))
                throw new Error("unexpected external request");
            return nativeFetch(url, init);
        });
        let roles;
        try {
            roles = await startConsoleAsyncAcceptanceEnvironment({
                databaseUrl,
                redisUrl,
                modelGatewayUrl: gateway.url,
            });
            const submit = async (key) => {
                const response = await fetch(`${roles.url}/process-runs`, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "idempotency-key": key,
                    },
                    body: JSON.stringify({
                        ...fixture.request,
                        input: {
                            ...fixture.request.input,
                            idea: "请联网搜梗，画雨狐给云撑伞",
                        },
                    }),
                });
                expect(response.status).toBe(202);
                return (await response.json()).runId;
            };
            const read = async (id) =>
                (
                    await fetch(`${roles.url}/console/runs/${id}/activities`)
                ).json();
            const [first, second] = await Promise.all([
                submit("pi-a"),
                submit("pi-b"),
            ]);
            expect(first).not.toEqual(second);
            expect(await submit("pi-a")).toBe(first);
            expect(await read(first)).toMatchObject({
                runId: first,
                queue: { status: "queued", createdAt: expect.any(String) },
                activities: [],
            });
            await roles.startWorker();
            try {
                await vi.waitFor(
                    async () => {
                        expect(gateway.counts.render).toBe(2);
                        for (const id of [first, second]) {
                            const { queue, activities } = await read(id);
                            expect(queue).toMatchObject({
                                status: "running",
                                startedAt: expect.any(String),
                            });
                            expect(queue.finishedAt).toBeUndefined();
                            expect(activities.at(-1)).toMatchObject({
                                event: "process_run_activity_started",
                                activity: "character_emoji_rendering",
                                activityId: 2,
                            });
                        }
                    },
                    { timeout: 10_000 },
                );
            } finally {
                rendering.resolve();
            }
            for (const id of [first, second]) {
                await vi.waitFor(
                    async () => {
                        const { queue, activities } = await read(id);
                        expect(queue).toMatchObject({
                            status: "succeeded",
                            createdAt: expect.any(String),
                            startedAt: expect.any(String),
                            finishedAt: expect.any(String),
                        });
                        expect(activities.at(-1)).toMatchObject({
                            event: "process_run_attempt_finished",
                            outcome: "succeeded",
                        });
                        expect(
                            activities.every(
                                (e) => e.runId === id && e.attemptNumber === 1,
                            ),
                        ).toBe(true);
                        expect(activities).toHaveLength(6);
                        expect(activities[2]).toMatchObject({
                            activity: "character_emoji_planning",
                            activityId: 1,
                            sessions: [
                                {
                                    sessionId: 1,
                                    validation: "passed",
                                    rounds: [
                                        {
                                            round: 1,
                                            tools: ["search_memes"],
                                            calls: [
                                                {
                                                    call: 1,
                                                    name: "search_memes",
                                                    result: "returned",
                                                },
                                            ],
                                        },
                                        { round: 2, tools: [], calls: [] },
                                    ],
                                },
                            ],
                        });
                        expect(activities[4]).toMatchObject({
                            activity: "character_emoji_rendering",
                            activityId: 2,
                        });
                    },
                    { timeout: 10000 },
                );
            }
            expect(gateway.counts).toEqual({ plan: 4, search: 2, render: 2 });
        } finally {
            rendering.resolve();
            await roles?.close();
            vi.unstubAllGlobals();
            await gateway.close();
        }
    },
    30000,
);
