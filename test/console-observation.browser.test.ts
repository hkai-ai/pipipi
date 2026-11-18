import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { createProcessingRequestListener } from "../src/api/http.js";
import { createInMemoryCallerApiKeyStore } from "../src/caller-api-keys/memory.js";
import {
    createJsonlProcessRunActivityArchive,
    createJsonlProcessRunRecordArchive,
    createJsonlRunObservationStats,
} from "../src/run-observation/jsonl.js";
import { chromeExecutable } from "./support/chrome.js";

const browserDescribe =
    process.env.RUN_CONSOLE_OBSERVATION_BROWSER === "1"
        ? describe
        : describe.skip;
browserDescribe("operator observation browser", () => {
    it("manages caller keys through a protected custom Console base path", async () => {
        const listener = createProcessingRequestListener(
            {
                execute: async () => {
                    throw new Error("Unexpected execution");
                },
            },
            {
                console: {
                    basePath: "/ops-secret",
                    assetDirectory: path.resolve("dist/console"),
                    records: {
                        list: async () => ({ records: [] }),
                        find: async () => undefined,
                    },
                    callerKeys: {
                        store: createInMemoryCallerApiKeyStore(),
                        persistent: false,
                        executeAuthMode: "audit",
                        gatewayFallbackEnabled: true,
                    },
                },
            },
        );
        const credentials = { username: "operator", password: "console-test" };
        const basic = Buffer.from(
            `${credentials.username}:${credentials.password}`,
        ).toString("base64");
        const server = createServer((request, response) => {
            if (request.headers.authorization !== `Basic ${basic}`) {
                response.writeHead(401, {
                    "www-authenticate": 'Basic realm="console-test"',
                });
                response.end();
                return;
            }
            listener(request, response);
        });
        const browser = await chromium.launch({
            executablePath: await chromeExecutable(),
            headless: true,
        });
        try {
            await new Promise<void>((resolve) =>
                server.listen(0, "127.0.0.1", resolve),
            );
            const address = server.address();
            if (!address || typeof address === "string")
                throw new Error("Missing address");
            const url = `http://127.0.0.1:${address.port}/ops-secret/`;
            expect((await fetch(`${url}caller-keys`)).status).toBe(401);
            const context = await browser.newContext({
                httpCredentials: credentials,
            });
            const page = await context.newPage();
            await page.goto(url);
            await page.getByRole("link", { name: "调用方密钥" }).click();
            await page.getByRole("heading", { name: "调用方密钥" }).waitFor();
            await page.getByText("audit", { exact: true }).waitFor();
            await page.getByText("本地内存开发模式").waitFor();
            await page
                .getByLabel("调用方 ID", { exact: true })
                .fill("memebuy-uat");
            await page
                .getByLabel("用途标签", { exact: true })
                .fill("UAT backend");
            await page.getByRole("button", { name: "发放密钥" }).click();
            const secret = page.locator(".secret-value");
            await secret.waitFor();
            expect(await secret.textContent()).toMatch(
                /^ppk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/,
            );
            const key = await secret.innerText();
            const keysTable = page.getByRole("table", { name: "密钥列表" });
            const audits = page.getByRole("table", { name: "操作审计" });
            const row = keysTable
                .getByRole("row")
                .filter({ hasText: "memebuy-uat" });
            await row.getByText("有效", { exact: true }).waitFor();
            await audits.getByText("发放", { exact: true }).waitFor();
            await page.setViewportSize({ width: 390, height: 844 });
            expect(
                await page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth,
                ),
            ).toBe(true);
            await page
                .getByRole("button", { name: "我已保存，关闭提示" })
                .click();
            await secret.waitFor({ state: "detached" });

            await page.getByLabel("按调用方 ID 筛选").fill("memebuy-uat");
            await page
                .getByRole("button", { name: "筛选", exact: true })
                .click();
            await page.waitForURL("**/#/caller-keys?callerId=memebuy-uat");
            await row
                .getByRole("button", { name: "吊销", exact: true })
                .click();
            await page.getByRole("alertdialog").waitFor();
            await page.getByLabel("吊销操作人").fill("operator");
            await page.getByLabel("吊销原因").fill("已轮换");
            await page.getByRole("button", { name: "确认吊销" }).click();
            await row.getByText("已吊销", { exact: true }).waitFor();
            await audits.getByText("已轮换", { exact: true }).waitFor();
            await page.reload();
            await row.getByText("已吊销", { exact: true }).waitFor();
            expect(await page.locator("body").innerText()).not.toContain(key);
            expect(await page.getByLabel("按调用方 ID 筛选").inputValue()).toBe(
                "memebuy-uat",
            );
            await context.close();
        } finally {
            await browser.close();
            if (server.listening)
                await new Promise<void>((resolve, reject) =>
                    server.close((error) =>
                        error ? reject(error) : resolve(),
                    ),
                );
        }
    }, 30_000);

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
        const planner = { name: "test-planner", version: "v1" };
        const single = { name: "test-planner", version: "v2" };
        const processes = [
            { version: "v2", skills: [planner] },
            { version: "v3", skills: [single] },
            { version: "v4", skills: [] },
        ].map(({ version, skills }) => ({
            process: "character-emoji",
            version,
            skills,
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
        const executablePath = await chromeExecutable();
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
            await page.getByText("56", { exact: true }).first().waitFor();
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
                await page
                    .getByRole("combobox", { name: "流程版本", exact: true })
                    .innerText(),
            ).toContain("v3");
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
            await page.locator(".ui-collapsible[data-open]").waitFor();
            expect(
                await page.locator(".ui-collapsible[data-open]").count(),
            ).toBe(1);
            expect(
                await page.locator(".ui-collapsible[data-open]").innerText(),
            ).toContain("流程版本 v3");
            const detail = page.locator(".ui-collapsible[data-open]");
            expect(await detail.innerText()).toContain(
                "当前声明的 Runtime Skill",
            );
            expect(
                await detail
                    .getByRole("link", { name: "test-planner · v2" })
                    .count(),
            ).toBe(1);
            expect(await detail.innerText()).not.toContain("test-planner · v1");
            await page.goto(
                `${url}#/processes?process=character-emoji&version=v2`,
            );
            await detail
                .getByRole("link", { name: "test-planner · v1" })
                .waitFor();
            expect(await detail.innerText()).not.toContain("test-planner · v2");
            await page.goto(
                `${url}#/processes?process=character-emoji&version=v4`,
            );
            await detail.getByText("此版本未绑定 Runtime Skill。").waitFor();
            await page.goto(
                filteredUrl
                    .replace("version=v3", "version=v99")
                    .replace("#/runs", "#/processes"),
            );
            await page.getByText("当前服务未注册", { exact: false }).waitFor();
            expect(
                await page.locator(".ui-collapsible[data-open]").count(),
            ).toBe(0);
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
            await page.getByText("会话轨迹未采集", { exact: true }).waitFor();
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
            expect(
                await page.locator(".ui-collapsible[data-open]").count(),
            ).toBe(0);
            await page.screenshot({
                path: path.join(output, "run-detail.png"),
                fullPage: true,
            });
            for (const [code, diagnosticCode] of [
                ["DEPENDENCY_FAILURE", "internal_failure"],
                ["DEPENDENCY_FAILURE", "dependency_failure"],
                ["DEPENDENCY_FAILURE_AFTER_COMMIT", "internal_failure"],
                ["DEPENDENCY_FAILURE_AFTER_COMMIT", "dependency_failure"],
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
                                            stage:
                                                diagnosticCode ===
                                                "dependency_failure"
                                                    ? "dependency"
                                                    : "execution",
                                            code: diagnosticCode,
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
                    .waitFor();
                expect(
                    await page
                        .locator(".failure-notice")
                        .getByText(expected, { exact: false })
                        .count(),
                ).toBe(1);
                expect(
                    await page.locator(".failure-notice h2").innerText(),
                ).toBe(
                    code === "DEPENDENCY_FAILURE"
                        ? "外部依赖失败"
                        : "副作用已提交，交付失败",
                );
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
                await page
                    .getByRole("combobox", { name: "流程版本", exact: true })
                    .innerText(),
            ).toContain("v3");
            await page.getByRole("link", { name: "清除筛选" }).click();
            await page.getByText("failure-v2", { exact: true }).waitFor();
            await page.goto(`${url}#/submit`);
            await page
                .getByRole("combobox", { name: "Business Process" })
                .click();
            await page
                .getByRole("option", { name: "character-emoji / v3" })
                .click();
            expect(
                await page
                    .getByRole("combobox", { name: "Business Process" })
                    .innerText(),
            ).toContain("character-emoji / v3");
            await page.goto(`${url}#/overview?hours=168`);
            await page.getByText("56", { exact: true }).first().waitFor();
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
            await page.getByText("56", { exact: true }).first().waitFor();
            await page.route("**/ops/stats?*", (route) =>
                route.fulfill({ status: 503, body: "unavailable" }),
            );
            await page
                .getByRole("button", { name: "刷新", exact: true })
                .click();
            await page.getByRole("alert").waitFor();
            expect(await page.getByText("56", { exact: true }).count()).toBe(0);
            // 历史父活动误记为成功，子运行只有活动归档，没有独立 Run Record。
            await records.store({
                schemaVersion: 1,
                runId: "template-parent",
                process: "template-from-source",
                version: "v2",
                status: "failed",
                errorCode: "DEPENDENCY_FAILURE_AFTER_COMMIT",
                recordedAt: at(1),
            });
            const event = {
                schemaVersion: 1,
                version: "v2",
                attemptNumber: 1,
                sequence: 1,
                timestamp: at(1),
                event: "process_run_activity_finished",
                durationMs: 5,
            } as const;
            activities.record({
                ...event,
                runId: "template-parent",
                process: "template-from-source",
                activity: "approved_image_compilation",
                outcome: "succeeded",
            });
            activities.record({
                ...event,
                runId: "template-parent:compile",
                process: "template-from-image",
                activity: "template_validation",
                outcome: "failed",
                diagnostic: {
                    stage: "schema",
                    code: "invalid_contract",
                    issues: [
                        {
                            path: "/review/checks/printForm/passed",
                            code: "check_failed",
                        },
                    ],
                },
            });
            await activities.flush();
            await page.goto(`${url}#/run/template-parent`);
            await page
                .getByRole("heading", { name: "模板编译子运行" })
                .waitFor();
            await page
                .getByText("/review/checks/printForm/passed", { exact: true })
                .waitFor();
            await page.getByText("check_failed", { exact: true }).waitFor();
            await page.getByText("印花形态未通过", { exact: false }).waitFor();
            // 在观察端没有任何终态记录时，从列表进入父运行并等待子阶段切换。
            const parent = {
                schemaVersion: 1 as const,
                runId: "live-parent",
                process: "template-from-source",
                version: "v3",
                timestamp: at(0),
                attemptNumber: 1,
            };
            const child = {
                ...parent,
                runId: "live-parent:compile",
                process: "template-from-image",
            };
            activities.record({
                ...parent,
                sequence: 1,
                event: "process_run_attempt_started",
            });
            await activities.flush();
            await page.goto(`${url}#/runs`);
            await page
                .getByRole("link", { name: parent.runId, exact: true })
                .click();
            activities.record({
                ...parent,
                sequence: 2,
                event: "process_run_activity_started",
                activity: "approved_image_compilation",
            });
            activities.record({
                ...child,
                sequence: 1,
                event: "process_run_attempt_started",
            });
            activities.record({
                ...child,
                sequence: 2,
                event: "process_run_activity_started",
                activity: "template_compilation",
            });
            await activities.flush();
            await page.getByText("当前步骤：编译模板").waitFor();
            activities.record({
                ...child,
                sequence: 3,
                event: "process_run_activity_finished",
                activity: "template_compilation",
                durationMs: 1,
                outcome: "succeeded",
            });
            activities.record({
                ...child,
                sequence: 4,
                event: "process_run_activity_started",
                activity: "template_review",
            });
            await activities.flush();
            await page.getByText("当前步骤：独立复核模板").waitFor();
            activities.record({
                ...child,
                sequence: 5,
                event: "process_run_activity_finished",
                activity: "template_review",
                durationMs: 1,
                outcome: "succeeded",
            });
            for (const entry of [child, parent])
                activities.record({
                    ...entry,
                    sequence: 6,
                    event: "process_run_attempt_finished",
                    durationMs: 2,
                    outcome: "succeeded",
                });
            await activities.flush();
            await records.store({
                schemaVersion: 1,
                runId: parent.runId,
                process: parent.process,
                version: "v3",
                templateSemanticsVersion: 4,
                status: "succeeded",
                recordedAt: at(0),
            });
            await page.getByRole("heading", { name: "输入与产出" }).waitFor();
            expect(await page.getByText("当前步骤：独立复核模板").count()).toBe(
                0,
            );
            await page.getByText("模板运行语义 V4", { exact: true }).waitFor();
            await page.goto(`${url}#/runs`);
            const templateRow = page
                .getByRole("row")
                .filter({ hasText: parent.runId });
            await templateRow
                .getByText("模板运行语义 V4", { exact: true })
                .waitFor();
            await templateRow
                .getByRole("link", { name: "流程版本 v3" })
                .waitFor();
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
