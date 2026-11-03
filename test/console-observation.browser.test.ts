import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { createProcessingRequestListener } from "../src/api/http.js";
import {
    createJsonlProcessRunActivityArchive,
    createJsonlProcessRunRecordArchive,
    createJsonlRunObservationStats,
} from "../src/run-observation/jsonl.js";

const browserDescribe =
    process.env.RUN_CONSOLE_OBSERVATION_BROWSER === "1"
        ? describe
        : describe.skip;
browserDescribe("operator observation browser", () => {
    it("drills from full-window failures to exact versions, returns to filters and handles unavailable data", async () => {
        const directory = await mkdtemp(
            path.join(tmpdir(), "pipipi-console-observation-"),
        );
        const now = new Date();
        const clock = () => now;
        const records = createJsonlProcessRunRecordArchive({
            directory,
            clock,
        });
        const activities = createJsonlProcessRunActivityArchive({
            directory,
            clock,
        });
        const stats = createJsonlRunObservationStats({ directory, clock });
        const at = (minutes: number) =>
            new Date(now.getTime() - minutes * 60_000).toISOString();
        const processes = ["v2", "v3"].map((version) => ({
            process: "character-emoji",
            version,
            activities: ["planning"],
            retry: { maximumAttempts: 1, retryableErrorCodes: [] },
            input: {
                type: "object",
                properties: { idea: { type: "string" } },
                required: ["idea"],
            },
        }));
        for (let i = 0; i < 54; i += 1)
            await records.store({
                schemaVersion: 1,
                runId: `failure-v3-${String(i).padStart(2, "0")}`,
                process: "character-emoji",
                version: "v3",
                status: "failed",
                errorCode: "AGENT_FAILURE",
                recordedAt: at(i + 1),
                content: { input: { idea: "私密测试正文" } },
            });
        await records.store({
            schemaVersion: 1,
            runId: "failure-v2",
            process: "character-emoji",
            version: "v2",
            status: "failed",
            errorCode: "AGENT_FAILURE",
            recordedAt: at(1),
        });
        await records.store({
            schemaVersion: 1,
            runId: "success-v3",
            process: "character-emoji",
            version: "v3",
            status: "succeeded",
            recordedAt: at(2),
        });
        activities.record({
            schemaVersion: 1,
            runId: "failure-v3-00",
            process: "character-emoji",
            version: "v3",
            attemptNumber: 1,
            sequence: 1,
            timestamp: at(1),
            event: "process_run_activity_finished",
            activity: "planning",
            outcome: "failed",
            durationMs: 1234,
            diagnostic: { stage: "json", code: "invalid_json" },
        });
        await activities.flush();
        let executions = 0;
        const server = createServer(
            createProcessingRequestListener(
                {
                    execute: async () => {
                        executions += 1;
                        throw new Error("No execution allowed");
                    },
                },
                {
                    console: {
                        basePath: "/ops",
                        assetDirectory: path.resolve("dist/console"),
                        records,
                        activities,
                        processes,
                        stats,
                    },
                },
            ),
        );
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        const address = server.address();
        if (!address || typeof address === "string")
            throw new Error("Missing address");
        const url = `http://127.0.0.1:${address.port}/ops/`;
        const executablePath =
            process.env.CHROME_PATH ??
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        await access(executablePath);
        const browser = await chromium.launch({
            executablePath,
            headless: true,
        });
        try {
            const context = await browser.newContext({
                viewport: { width: 1440, height: 1100 },
            });
            const page = await context.newPage();
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(url);
            await page.getByRole("heading", { name: "运行概览" }).waitFor();
            await page.getByText("56", { exact: true }).waitFor();
            await page.getByText("54", { exact: true }).first().waitFor();
            const output = path.resolve("artifacts/agent-diagnostics/console");
            await mkdir(output, { recursive: true });
            await page.screenshot({
                path: path.join(output, "overview.png"),
                fullPage: true,
            });
            await page
                .getByRole("link", { name: "异常排查", exact: true })
                .click();
            await page.getByRole("heading", { name: "异常排查" }).waitFor();
            const group = page
                .getByRole("row")
                .filter({ hasText: "character-emoji / v3" })
                .filter({ hasText: "54" });
            await group.getByRole("link", { name: "排查记录" }).click();
            await page.getByText("已加载 50 条").waitFor();
            expect(
                await page.getByLabel("流程版本", { exact: true }).inputValue(),
            ).toBe("v3");
            expect(
                await page.getByText("failure-v2", { exact: true }).count(),
            ).toBe(0);
            await page.getByRole("button", { name: "加载更早" }).click();
            await page.getByText("已加载 54 条").waitFor();
            const filteredUrl = page.url();
            const failedRow = page
                .getByRole("row")
                .filter({ hasText: "failure-v3-00" });
            expect(await failedRow.innerText()).not.toContain("AGENT_FAILURE");
            await failedRow
                .getByRole("button", { name: "Agent 执行失败" })
                .hover();
            await page.getByRole("tooltip").waitFor();
            expect(await page.getByRole("tooltip").innerText()).toContain(
                "检查模型依赖",
            );
            await page.keyboard.press("Escape");
            await page.getByRole("tooltip").waitFor({ state: "hidden" });
            await failedRow.getByRole("link", { name: "流程版本 v3" }).click();
            await page
                .getByText("流程版本定义一次业务调用", { exact: false })
                .waitFor();
            await page.locator("details[open]").waitFor();
            expect(await page.locator("details[open]").count()).toBe(1);
            expect(await page.locator("details[open]").innerText()).toContain(
                "流程版本 v3",
            );
            await page.goto(
                filteredUrl
                    .replace("version=v3", "version=v99")
                    .replace("#/runs", "#/processes"),
            );
            await page.getByText("当前服务未注册", { exact: false }).waitFor();
            expect(await page.locator("details[open]").count()).toBe(0);
            await page.goto(filteredUrl);
            await page.getByText("已加载 50 条").waitFor();
            await page.evaluate(() => window.scrollTo(0, 700));
            expect(
                await page
                    .locator(".sidebar")
                    .evaluate((element) =>
                        Math.abs(element.getBoundingClientRect().top),
                    ),
            ).toBeLessThan(1);

            await page
                .getByRole("link", { name: "failure-v3-00", exact: true })
                .click();
            await page.getByRole("heading", { name: "运行详情" }).waitFor();
            await page
                .getByRole("heading", {
                    name: "解析模型 JSON：模型结果不是合法 JSON",
                })
                .waitFor();
            expect(await page.locator(".failure-notice").innerText()).toContain(
                "请检查模型结构化输出能力与编译规则",
            );
            await page
                .getByText("失败步骤：业务处理步骤", { exact: true })
                .waitFor();
            expect(await page.locator("details[open]").count()).toBe(0);
            await page.screenshot({
                path: path.join(output, "run-detail.png"),
                fullPage: true,
            });
            for (const code of [
                "DEPENDENCY_FAILURE",
                "DEPENDENCY_FAILURE_AFTER_COMMIT",
            ]) {
                await page.route("**/runs/failure-v3-00", async (route) => {
                    const response = await route.fetch();
                    await route.fulfill({
                        response,
                        json: { ...(await response.json()), errorCode: code },
                    });
                });
                await page.route(
                    "**/runs/failure-v3-00/activities",
                    async (route) => {
                        const response = await route.fetch();
                        const body = await response.json();
                        await route.fulfill({
                            response,
                            json: {
                                ...body,
                                activities: body.activities.map(
                                    (entry: Record<string, unknown>) => ({
                                        ...entry,
                                        extra: "PRIVATE_EVENT_SENTINEL",
                                        diagnostic: {
                                            stage: "execution",
                                            code: "internal_failure",
                                            message: "PRIVATE_EVENT_SENTINEL",
                                        },
                                    }),
                                ),
                            },
                        });
                    },
                );
                await page.reload();
                const expected =
                    code === "DEPENDENCY_FAILURE"
                        ? "重新提交前确认原请求是否已受理"
                        : "不应直接重新生成或重放付费操作";
                await page
                    .locator(".failure-notice")
                    .getByText(expected, { exact: false })
                    .first()
                    .waitFor();
                await page
                    .getByText("技术详情：原始事件与步骤标识", { exact: true })
                    .click();
                expect(
                    await page.locator(".technical-details pre").innerText(),
                ).not.toContain("PRIVATE_EVENT_SENTINEL");
                await page.unroute("**/runs/failure-v3-00");
                await page.unroute("**/runs/failure-v3-00/activities");
            }
            await page.getByRole("link", { name: "返回查询页面" }).click();
            await page.getByText("已加载 50 条").waitFor();
            expect(page.url()).toBe(filteredUrl);
            await page.reload();
            await page.getByText("已加载 50 条").waitFor();
            expect(
                await page.getByLabel("流程版本", { exact: true }).inputValue(),
            ).toBe("v3");
            await page.getByRole("link", { name: "清除筛选" }).click();
            await page.getByText("failure-v2", { exact: true }).waitFor();
            await page.goto(`${url}#/submit`);
            await page
                .getByLabel("Business Process")
                .selectOption("character-emoji/v3");
            expect(await page.getByLabel("Business Process").inputValue()).toBe(
                "character-emoji/v3",
            );
            await page.goto(`${url}#/overview?hours=168`);
            await page.getByText("56", { exact: true }).waitFor();
            await page.setViewportSize({ width: 390, height: 844 });
            await page.screenshot({
                path: path.join(output, "overview-mobile.png"),
                fullPage: false,
            });
            expect(await page.locator(".console-layout").count()).toBe(1);
            expect(
                await page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth,
                ),
            ).toBe(true);
            await page.emulateMedia({ colorScheme: "dark" });
            await page.screenshot({
                path: path.join(output, "overview-dark.png"),
                fullPage: false,
            });
            await page
                .getByRole("heading", { name: "需要关注" })
                .scrollIntoViewIfNeeded();
            await page.screenshot({
                path: path.join(output, "overview-mobile-exceptions.png"),
                fullPage: false,
            });
            await page.goto(`${url}#/run/failure-v3-00`);
            await page
                .getByText("失败步骤：业务处理步骤", { exact: true })
                .waitFor();
            await page.setViewportSize({ width: 320, height: 844 });
            expect(
                await page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth,
                ),
            ).toBe(true);
            await page.screenshot({
                path: path.join(output, "run-mobile.png"),
                fullPage: false,
            });
            await page.goto(`${url}#/overview`);
            await page.getByText("56", { exact: true }).waitFor();
            await page.route("**/ops/stats?*", (route) =>
                route.fulfill({ status: 503, body: "unavailable" }),
            );
            await page
                .getByRole("button", { name: "刷新", exact: true })
                .click();
            await page.getByRole("alert").waitFor();
            expect(await page.getByText("56", { exact: true }).count()).toBe(0);
            expect(executions).toBe(0);
            expect(errors).toEqual([]);
            await context.close();
        } finally {
            await browser.close();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
            await rm(directory, { recursive: true, force: true });
        }
    }, 60_000);
});
