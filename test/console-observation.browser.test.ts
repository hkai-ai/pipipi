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
            const output = path.resolve("artifacts/console-iteration");
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
                await page.getByLabel("版本", { exact: true }).inputValue(),
            ).toBe("v3");
            expect(
                await page.getByText("failure-v2", { exact: true }).count(),
            ).toBe(0);
            await page.getByRole("button", { name: "加载更早" }).click();
            await page.getByText("已加载 54 条").waitFor();
            const filteredUrl = page.url();
            await page
                .getByRole("link", { name: "failure-v3-00", exact: true })
                .click();
            await page.getByRole("heading", { name: "运行详情" }).waitFor();
            await page
                .getByText("失败活动：planning", { exact: true })
                .waitFor();
            expect(await page.locator("details[open]").count()).toBe(0);
            await page.screenshot({
                path: path.join(output, "run-detail.png"),
                fullPage: true,
            });
            await page.getByRole("link", { name: "返回查询页面" }).click();
            await page.getByText("已加载 50 条").waitFor();
            expect(page.url()).toBe(filteredUrl);
            await page.reload();
            await page.getByText("已加载 50 条").waitFor();
            expect(
                await page.getByLabel("版本", { exact: true }).inputValue(),
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
                .getByText("失败活动：planning", { exact: true })
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
