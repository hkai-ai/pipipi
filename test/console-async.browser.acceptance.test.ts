import { access } from "node:fs/promises";
import path from "node:path";
import { chromium, type Request } from "playwright-core";
import { describe, expect, it } from "vitest";
import { startConsoleAsyncAcceptanceEnvironment } from "./support/console-async-acceptance-environment.js";

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_TEST_URL;
const acceptanceDescribe =
    process.env.RUN_CONSOLE_BROWSER_ACCEPTANCE === "1" &&
    databaseUrl &&
    redisUrl
        ? describe
        : describe.skip;

acceptanceDescribe("built Console async browser acceptance", () => {
    it("recovers one submission and traces success and failure across Console views", async () => {
        const environment = await startConsoleAsyncAcceptanceEnvironment({
            databaseUrl: databaseUrl as string,
            redisUrl: redisUrl as string,
            assetDirectory: path.resolve("dist/console"),
        });
        try {
            const browser = await chromium.launch({
                executablePath: await chromeExecutable(),
                headless: true,
            });
            try {
                const context = await browser.newContext();
                try {
                    const page = await context.newPage();
                    const processRequests: Request[] = [];
                    page.on("request", (request) => {
                        if (
                            new URL(request.url()).pathname.startsWith(
                                "/process-runs",
                            )
                        ) {
                            processRequests.push(request);
                        }
                    });

                    await page.goto(`${environment.url}/console/#/submit`);
                    const process = page.getByLabel("Business Process");
                    await process.waitFor();
                    await process.selectOption("content-processing");
                    await page
                        .getByLabel(/^content \*$/)
                        .fill("browser acceptance");

                    const submit = page.getByRole("button", {
                        name: "提交",
                        exact: true,
                    });
                    await submit.click({ noWaitAfter: true });
                    const progress = page.getByText(
                        /Run [0-9a-f-]{36} 已接受，当前状态：queued/,
                    );
                    await progress.waitFor({ timeout: 10_000 });
                    expect(
                        await page
                            .getByRole("button", {
                                name: "等待结果…",
                                exact: true,
                            })
                            .isDisabled(),
                    ).toBe(true);
                    const progressText = await progress.innerText();
                    const runId = /Run ([0-9a-f-]{36}) 已接受/.exec(
                        progressText,
                    )?.[1];
                    expect(runId).toMatch(/^[0-9a-f-]{36}$/);

                    const submissions = processRequests.filter(
                        (request) => request.method() === "POST",
                    );
                    expect(submissions).toHaveLength(1);
                    expect(submissions[0]?.postDataJSON()).toEqual({
                        process: "content-processing",
                        version: "v1",
                        input: { content: "browser acceptance" },
                    });

                    await page.reload();
                    const recovery = page.getByText(/检测到可恢复操作/);
                    await recovery.waitFor({ timeout: 10_000 });
                    expect(await recovery.innerText()).toContain(runId);
                    expect(
                        await page
                            .getByRole("button", {
                                name: "先继续查询或移除已接受 Run",
                                exact: true,
                            })
                            .isDisabled(),
                    ).toBe(true);

                    await page
                        .getByRole("button", {
                            name: "继续查询",
                            exact: true,
                        })
                        .click({ noWaitAfter: true });
                    await environment.startWorker();

                    const terminal = page.getByText(
                        new RegExp(`Run ${runId} · succeeded`),
                    );
                    await terminal.waitFor({ timeout: 15_000 });
                    expect(await terminal.innerText()).toContain("succeeded");
                    await page
                        .getByText(/"content": "Processed: browser acceptance"/)
                        .waitFor({ timeout: 5_000 });
                    expect(
                        processRequests.filter(
                            (request) => request.method() === "POST",
                        ),
                    ).toHaveLength(1);
                    expect(
                        processRequests.some(
                            (request) =>
                                request.method() === "GET" &&
                                new URL(request.url()).pathname ===
                                    `/process-runs/${runId}`,
                        ),
                    ).toBe(true);
                    for (const request of processRequests) {
                        const headers = request.headers();
                        expect(headers["x-pipipi-caller-id"]).toBeUndefined();
                        expect(
                            headers["x-pipipi-gateway-token"],
                        ).toBeUndefined();
                    }
                    expect(environment.effectCount("browser acceptance")).toBe(
                        1,
                    );

                    await page.goto(`${environment.url}/console/#/submit`);
                    await page
                        .getByLabel("Business Process")
                        .selectOption("content-processing");
                    await page
                        .getByLabel(/^content \*$/)
                        .fill("browser failure");
                    await page
                        .getByRole("button", { name: "提交", exact: true })
                        .click({ noWaitAfter: true });
                    const failed = page.getByText(/Run [0-9a-f-]{36} · failed/);
                    await failed.waitFor({ timeout: 15_000 });
                    const failedRunId = /Run ([0-9a-f-]{36}) · failed/.exec(
                        await failed.innerText(),
                    )?.[1];
                    expect(failedRunId).toMatch(/^[0-9a-f-]{36}$/);

                    await page.goto(`${environment.url}/console/#/runs`);
                    await page
                        .getByLabel("Process")
                        .selectOption("content-processing");
                    await page.getByLabel("状态").selectOption("failed");
                    await page.getByLabel("错误码").fill("dependency_failure");
                    await page
                        .getByLabel("起始（含）")
                        .fill("2020-01-01T00:00");
                    await page
                        .getByLabel("结束（不含）")
                        .fill("2099-01-01T00:00");
                    await page
                        .getByRole("button", { name: "应用筛选" })
                        .click();
                    await page.getByText(failedRunId as string).waitFor({
                        timeout: 5_000,
                    });

                    await page.goto(`${environment.url}/console/#/stats`);
                    await page
                        .getByText("每日吞吐与失败分布")
                        .waitFor({ timeout: 5_000 });
                    await page.getByText("最近失败").waitFor();
                    await page.getByText(failedRunId as string).waitFor();

                    await page.goto(
                        `${environment.url}/console/#/run/${failedRunId}`,
                    );
                    await page
                        .getByText(/声明顺序：content_processing/)
                        .waitFor({ timeout: 5_000 });
                    await page.getByText(/与声明一致/).waitFor();
                } finally {
                    await context.close();
                }
            } finally {
                await browser.close();
            }
        } finally {
            await environment.close();
        }
    }, 60_000);
});

async function chromeExecutable(): Promise<string> {
    const candidates = [
        process.env.CHROME_PATH,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ].filter((candidate): candidate is string => Boolean(candidate));
    for (const candidate of candidates) {
        try {
            await access(candidate);
            return candidate;
        } catch {}
    }
    throw new Error(
        "Chrome is required; set CHROME_PATH to a Chromium-compatible executable",
    );
}
