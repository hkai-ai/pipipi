import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { agentDiagnostic } from "../src/agent-runtime/diagnostics.js";
import { AgentExecutionFailure } from "../src/agent-runtime/failure.js";
import { sanitizeActivityDiagnostic } from "../src/process-runtime/diagnostics.js";
import {
    createProcessRegistry,
    createProcessRunner,
    type ProcessRegistration,
    type ProcessRunLogRecord,
} from "../src/process-runtime/index.js";
import { createCrtRegistration } from "../src/processes/crt/registration.js";
import { createNewsImageRegistration } from "../src/processes/news-image/registration.js";
import { createPhotoPosterRegistration } from "../src/processes/photo-poster/registration.js";
import { createPosterRegistration } from "../src/processes/poster/registration.js";

const secret = "private-content https://private.example/?key=secret";
const photo = "https://assets.example/photo.png";
const cases: {
    name: string;
    input: unknown;
    attempts: number;
    build: (
        compile: () => Promise<never>,
        render: () => Promise<never>,
    ) => ProcessRegistration;
}[] = [
    {
        name: "poster",
        input: { brief: "test" },
        attempts: 1,
        build: (compile, render) =>
            createPosterRegistration({
                agent: { compile },
                capability: { render },
            }),
    },
    {
        name: "crt",
        input: { sourceImageUrl: photo, palette: "经典", aspectRatio: "3:4" },
        attempts: 2,
        build: (compile, render) =>
            createCrtRegistration({
                agent: { compile },
                capability: { transform: render },
            }),
    },
    ...(["narrative-monument", "pale-watercolor", "raw-humanism"] as const).map(
        (style) => ({
            name: style,
            input: { title: "test", summary: "test" },
            attempts: 1,
            build: (
                compile: () => Promise<never>,
                render: () => Promise<never>,
            ) =>
                createNewsImageRegistration(style, {
                    agent: { compile },
                    capability: { render },
                }),
        }),
    ),
    {
        name: "photo",
        input: { sourceImageUrl: photo, phrase: "QUIET PAWS" },
        attempts: 1,
        build: (compile, render) =>
            createPhotoPosterRegistration("travel-abstraction", {
                agent: { compile },
                capability: { render },
            }),
    },
];

describe("shared Agent diagnostics", () => {
    it.each(cases)(
        "$name uses the same provider failure without changing its call budget",
        async ({ build, input, attempts }) => {
            const compile = vi.fn(async (): Promise<never> => {
                throw Object.assign(new Error(secret), { status: 503 });
            });
            const render = vi.fn(async (): Promise<never> => {
                throw new Error("must not run");
            });
            const registration = build(compile, render);
            const events: ProcessRunLogRecord[] = [];
            const runner = createProcessRunner({
                registry: createProcessRegistry([registration]),
                runLogSink: (event) => events.push(event),
            });
            const result = await runner.execute({
                process: registration.identity.id,
                version: "v1",
                input,
            });
            expect(result).toMatchObject({
                status: "failed",
                error: {
                    code: "AGENT_FAILURE",
                    message: expect.stringContaining("模型服务暂时不可用"),
                },
            });
            expect(events).toContainEqual(
                expect.objectContaining({
                    event: "process_run_activity_finished",
                    outcome: "failed",
                    diagnostic: {
                        stage: "request",
                        code: "provider_unavailable",
                    },
                }),
            );
            expect(compile).toHaveBeenCalledTimes(attempts);
            expect(render).not.toHaveBeenCalled();
            expect(JSON.stringify({ result, events })).not.toMatch(
                /private-content|private\.example|key=secret/,
            );
        },
    );
    it("uses bounded fixed field paths and rule codes instead of Zod messages or keys", () => {
        const result = z
            .strictObject({
                recipe: z.object({ layout: z.string() }),
                prompt: z.string(),
            })
            .safeParse({
                recipe: { layout: 42 },
                prompt: 42,
                [secret]: secret,
            });
        if (result.success) throw new Error("fixture must fail");
        expect(agentDiagnostic(result.error)).toEqual({
            stage: "schema",
            code: "invalid_schema",
            issues: [
                { path: "/recipe/layout", code: "invalid_type" },
                { path: "/prompt", code: "invalid_type" },
                { path: "/", code: "unrecognized_keys" },
            ],
        });
        expect(
            sanitizeActivityDiagnostic({
                stage: "schema",
                code: "invalid_schema",
                message: secret,
                issues: [{ path: `/recipe/${secret}`, code: secret }],
            }),
        ).toMatchObject({
            issues: [{ path: "/recipe/*/*/*/*", code: "custom" }],
        });
        expect(JSON.stringify(agentDiagnostic(result.error))).not.toContain(
            secret,
        );
    });
    it("keeps explicit session and system codes, and never guesses from arbitrary message numbers", () => {
        expect(
            agentDiagnostic(
                new AgentExecutionFailure({
                    stage: "session",
                    code: "configuration",
                }),
            ),
        ).toEqual({ stage: "session", code: "configuration" });
        expect(
            agentDiagnostic(
                Object.assign(new Error(secret), { code: "ETIMEDOUT" }),
            ),
        ).toEqual({ stage: "request", code: "timeout" });
        expect(
            agentDiagnostic(
                Object.assign(new Error(secret), {
                    code: "context_length_exceeded",
                }),
            ),
        ).toEqual({ stage: "request", code: "context_limit" });
        expect(
            agentDiagnostic(new Error(`user text 401 429 ${secret}`)),
        ).toEqual({ stage: "request", code: "execution" });
        expect(
            sanitizeActivityDiagnostic({
                stage: { toString: () => "request", secret },
                code: "execution",
            }),
        ).toBeUndefined();
    });
});
