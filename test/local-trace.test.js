import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
it("discovers a live /execute run, reads approved fields and discards them on completion", async () => {
    const archive = await mkdtemp(join(tmpdir(), "local-trace-"));
    const rendering = Promise.withResolvers();
    const release = Promise.withResolvers();
    const gateway = await startDemoGateway(fixture, true, {
        thinking: "HIDDEN_REASONING_PROBE_417",
        beforeRender: () => {
            rendering.resolve();
            return release.promise;
        },
    });
    const idea = "请联网搜梗，本地输入探针-417";
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (url, init) => {
        if (
            String(url) === fixture.request.input.cast[0].referenceImageUrl &&
            init?.method === "HEAD"
        )
            return Promise.resolve(new Response(null));
        if (!String(url).startsWith("http://127.0.0.1:"))
            throw new Error("unexpected external request");
        return originalFetch(url, init);
    });
    const { application } = constructProcessingService({
        NODE_ENV: "development",
        CONSOLE_LOCAL_TRACE: "true",
        CONSOLE_ENABLED: "true",
        CONSOLE_ASSET_DIRECTORY: resolve("dist/console"),
        PI_PROVIDER: "openai",
        PI_MODEL: "gpt-5.4",
        MODEL_GATEWAY_BASE_URL: `${gateway.url}/v1`,
        MODEL_GATEWAY_API_KEY: "offline-secret",
        CRT_BUSINESS_API_BASE_URL: gateway.url,
        PROCESS_RUN_RECORD_DIRECTORY: archive,
        PROCESS_RUN_RECORD_CONTENT: "omit",
        PROCESS_RUN_LOG_LEVEL: "silent",
    });
    const log = vi.spyOn(process.stdout, "write");
    let request, browser;
    try {
        const { url } = await application.listen();
        request = fetch(`${url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                ...fixture.request,
                input: { ...fixture.request.input, idea },
            }),
        }).then((r) => r.json());
        await Promise.race([
            rendering.promise,
            request.then(() => {
                throw new Error("run ended before rendering");
            }),
        ]);
        const endpoint = `${url}/console/live`;
        const proxied = await fetch(endpoint, {
            headers: { "x-forwarded-for": "127.0.0.1" },
        });
        expect(proxied.status).toBe(404);
        const listing = await fetch(endpoint);
        expect(listing.status).toBe(200);
        const { runs } = await listing.json();
        expect(runs).toHaveLength(1);
        const { runId } = runs[0];
        const detail = await fetch(`${endpoint}/${runId}`);
        expect(detail.headers.get("cache-control")).toBe("no-store");
        const { events } = await detail.json();
        expect(events).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: "input",
                    field: "idea",
                    value: idea,
                }),
                expect.objectContaining({
                    kind: "toolCall",
                    field: "focus",
                    value: "雨狐给云撑伞",
                }),
                expect.objectContaining({
                    kind: "model",
                    field: "scene",
                    value: fixture.output.plan.scene,
                }),
                expect.objectContaining({
                    kind: "toolResult",
                    note: expect.any(String),
                }),
                expect.objectContaining({
                    kind: "validation",
                    value: "passed",
                }),
            ]),
        );
        for (const text of [
            "offline-secret",
            "HIDDEN_REASONING_PROBE_417",
            "本地演示无可引用",
            "雨狐为云撑伞",
            "referenceImageUrl",
        ])
            expect(JSON.stringify(events)).not.toContain(text);
        let page;
        if (process.env.RUN_CONSOLE_OBSERVATION_BROWSER === "1") {
            browser = await chromium.launch({
                executablePath:
                    process.env.CHROME_PATH ??
                    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            });
            page = await browser.newPage();
            await page.goto(`${url}/console/`);
            await page.getByRole("link", { name: "本地实时调试" }).click();
            await page.getByRole("link", { name: runId }).click();
            await page.getByText("模型回复 · scene").click();
            await page
                .getByText(fixture.output.plan.scene, { exact: true })
                .waitFor();
        }
        release.resolve();
        expect(await request).toMatchObject({ runId, status: "succeeded" });
        expect((await fetch(`${endpoint}/${runId}`)).status).toBe(404);
        expect(await (await fetch(endpoint)).json()).toEqual({ runs: [] });
        if (page) {
            await page.getByText("请求已结束，实时正文已清除。").waitFor();
            expect(
                await page
                    .getByText(fixture.output.plan.scene, { exact: true })
                    .count(),
            ).toBe(0);
        }
        const activities = await (
            await fetch(`${url}/console/runs/${runId}/activities`)
        ).text();
        const history = await (
            await fetch(`${url}/console/runs/${runId}`)
        ).text();
        for (const text of [
            idea,
            "本地演示无可引用",
            "offline-secret",
            "HIDDEN_REASONING_PROBE_417",
            "雨狐为云撑伞",
        ])
            expect(activities + history).not.toContain(text);
        const logs = log.mock.calls.map(([line]) => String(line)).join("");
        for (const text of [
            idea,
            fixture.output.plan.scene,
            "本地演示无可引用",
            "offline-secret",
            "HIDDEN_REASONING_PROBE_417",
            "雨狐为云撑伞",
        ])
            expect(logs).not.toContain(text);
        const files = await readdir(archive, {
            recursive: true,
            withFileTypes: true,
        });
        for (const f of files.filter((f) => f.isFile())) {
            const contents = await readFile(join(f.parentPath, f.name), "utf8");
            for (const probe of [
                idea,
                "HIDDEN_REASONING_PROBE_417",
                "本地演示无可引用",
                "offline-secret",
                "雨狐为云撑伞",
            ])
                expect(contents).not.toContain(probe);
        }
    } finally {
        release.resolve();
        await request;
        await browser?.close();
        log.mockRestore();
        vi.unstubAllGlobals();
        await application.close();
        await gateway.close();
        await rm(archive, { recursive: true, force: true, maxRetries: 3 });
    }
}, 20000);

it.each([
    { NODE_ENV: "development" },
    { NODE_ENV: "production", CONSOLE_LOCAL_TRACE: "true" },
])(
    "does not expose live content without an explicitly enabled development console (%o)",
    async (environment) => {
        const archive = await mkdtemp(join(tmpdir(), "local-trace-disabled-"));
        const { application } = constructProcessingService({
            ...environment,
            CONSOLE_ENABLED: "true",
            CONSOLE_ASSET_DIRECTORY: resolve("dist/console"),
            PROCESS_RUN_RECORD_DIRECTORY: archive,
            CRT_BUSINESS_API_BASE_URL: "http://127.0.0.1:1",
        });
        try {
            const { url } = await application.listen();
            expect((await fetch(`${url}/console/live`)).status).toBe(404);
            const html = await (await fetch(`${url}/console/`)).text();
            expect(html).not.toContain('name="pipipi-local-trace"');
        } finally {
            await application.close();
            await rm(archive, { recursive: true, force: true, maxRetries: 3 });
        }
    },
);
