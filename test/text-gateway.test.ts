import { describe, expect, it } from "vitest";
import { resolveTextGateway } from "../src/agent-runtime/text-gateway.js";
import { checkDeploymentEnvironment } from "../src/app/deployment-environment.js";
import { createPosterSkillRefs } from "../src/processes/poster/skills.js";

describe("shared text gateway configuration", () => {
    it("selects the canonical pair together even when legacy credentials remain", () => {
        expect(
            resolveTextGateway({
                TEXT_MODEL_BASE_URL: "https://new.example/v1",
                TEXT_MODEL_API_KEY: "new-key",
                CHARACTER_EMOJI_BASE_URL: "https://previous.example/v1",
                CHARACTER_EMOJI_API_KEY: "previous-key",
                OPENAI_BASE_URL: "https://old.example/v1",
                OPENAI_API_KEY: "old-key",
            }),
        ).toEqual({ baseUrl: "https://new.example/v1", apiKey: "new-key" });
    });
    it.each(["TEXT_MODEL_BASE_URL", "TEXT_MODEL_API_KEY"])(
        "rejects an incomplete canonical pair with only %s",
        (key) => {
            expect(() =>
                resolveTextGateway({
                    [key]: key.endsWith("URL")
                        ? "https://new.example/v1"
                        : "new-key",
                    CHARACTER_EMOJI_BASE_URL: "https://previous.example/v1",
                    CHARACTER_EMOJI_API_KEY: "previous-key",
                    OPENAI_BASE_URL: "https://old.example/v1",
                    OPENAI_API_KEY: "old-key",
                }),
            ).toThrow(/TEXT_MODEL/);
        },
    );
    it("supports the previous CHARACTER pair before the OPENAI fallback", () => {
        expect(
            resolveTextGateway({
                CHARACTER_EMOJI_BASE_URL: "https://previous.example/v1",
                CHARACTER_EMOJI_API_KEY: "previous-key",
                OPENAI_BASE_URL: "https://old.example/v1",
                OPENAI_API_KEY: "old-key",
            }),
        ).toEqual({
            baseUrl: "https://previous.example/v1",
            apiKey: "previous-key",
        });
    });
    it.each(["CHARACTER_EMOJI_BASE_URL", "CHARACTER_EMOJI_API_KEY"])(
        "rejects a partial previous pair with %s instead of mixing with OPENAI",
        (key) => {
            expect(() =>
                resolveTextGateway({
                    [key]: key.endsWith("URL")
                        ? "https://previous.example/v1"
                        : "previous-key",
                    OPENAI_BASE_URL: "https://old.example/v1",
                    OPENAI_API_KEY: "old-key",
                }),
            ).toThrow(/CHARACTER_EMOJI/);
        },
    );
    it("uses legacy credentials only when the canonical pair is absent", () => {
        expect(
            resolveTextGateway({
                OPENAI_BASE_URL: "https://old.example/v1",
                OPENAI_API_KEY: "old-key",
            }),
        ).toEqual({ baseUrl: "https://old.example/v1", apiKey: "old-key" });
    });
    it.each(["api", "process-worker"] as const)(
        "preflights %s using the same selected credential pair",
        (role) => {
            const result = checkDeploymentEnvironment(
                {
                    PI_PROVIDER: "openai",
                    TEXT_MODEL_BASE_URL: "https://new.example/v1",
                    TEXT_MODEL_API_KEY: "new-key",
                },
                role,
                { includeProviderCredentials: true },
            );
            expect(result.requiredVariables).toContain("TEXT_MODEL_API_KEY");
            expect(result.requiredVariables).not.toContain("OPENAI_API_KEY");
            expect(result.missingVariables).not.toContain("TEXT_MODEL_API_KEY");
        },
    );
});

it("routes production poster and character planning through the same gateway, ignoring stale legacy and planner settings", async () => {
    const { createServer } = await import("node:http");
    const { createProductionRuntime } = await import(
        "../src/app/business-processes.js"
    );
    const calls: { path: string; key: string | undefined; model: string }[] =
        [];
    const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        calls.push({
            path: request.url ?? "",
            key: request.headers.authorization,
            model: body.model,
        });
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
            JSON.stringify({
                error: { message: "synthetic gateway rejection" },
            }),
        );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Missing address");
    try {
        const runtime = createProductionRuntime(
            {
                PI_PROVIDER: "openai",
                PI_MODEL: "gpt-5.4-mini",
                TEXT_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
                TEXT_MODEL_API_KEY: "shared-key",
                CHARACTER_EMOJI_BASE_URL: "http://127.0.0.1:1/v1",
                CHARACTER_EMOJI_API_KEY: "previous-key",
                OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
                OPENAI_API_KEY: "stale-key",
                CHARACTER_EMOJI_PLANNER_BASE_URL: "http://127.0.0.1:1/v1",
                CHARACTER_EMOJI_PLANNER_API_KEY: "stale-planner",
                CRT_BUSINESS_API_BASE_URL: "http://127.0.0.1:1",
                PROCESS_TIMEOUT_MS: "10000",
            },
            { runLogSink: () => {} },
        );
        await runtime.executor.execute({
            process: "minimal-zine-poster",
            version: "v1",
            input: { brief: "Synthetic gateway test" },
        });
        await runtime.executor.execute({
            process: "character-emoji",
            version: "v3",
            input: {
                cast: [{ character: "Claude", appearance: "Girl" }],
                idea: "喝茶",
            },
        });
        const { ResponsesMemeSearch } = await import(
            "../src/processes/character-emoji/search.responses.js"
        );
        const gateway = resolveTextGateway({
            TEXT_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            TEXT_MODEL_API_KEY: "shared-key",
            OPENAI_API_KEY: "stale-key",
        });
        if (!gateway.baseUrl || !gateway.apiKey)
            throw new Error("Missing gateway");
        await expect(
            new ResponsesMemeSearch({
                gateway,
            }).search(
                {
                    cast: [{ character: "Claude", appearance: "Girl" }],
                    idea: "Synthetic",
                },
                {
                    signal: AbortSignal.timeout(5000),
                    maxKeywords: 1,
                    maxOutputTokens: 64,
                },
            ),
        ).rejects.toThrow();
        expect(calls).toEqual([
            {
                path: "/v1/chat/completions",
                key: "Bearer shared-key",
                model: "gpt-5.4-mini",
            },
            {
                path: "/v1/responses",
                key: "Bearer shared-key",
                model: "deepseek-v4.1-flash",
            },
            {
                path: "/v1/responses",
                key: "Bearer shared-key",
                model: "deepseek-v4-flash-260425",
            },
        ]);
    } finally {
        await new Promise<void>((done) => server.close(() => done()));
    }
});

it("keeps concurrent Pi gateway credentials isolated from each other and the ambient key", async () => {
    const { createServer } = await import("node:http");
    const { PiStructuredAgent } = await import(
        "../src/agent-runtime/structured.js"
    );
    const keys: string[] = [];
    const server = createServer(async (request, response) => {
        for await (const _chunk of request) {
            /* drain local synthetic prompt */
        }
        keys.push(request.headers.authorization ?? "");
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"error":{"message":"synthetic"}}');
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Missing address");
    const original = process.env.OPENAI_API_KEY;
    try {
        process.env.OPENAI_API_KEY = "ambient-stale-key";
        const agents = ["a-key", "b-key"].map(
            (apiKey) =>
                new PiStructuredAgent({
                    skills: createPosterSkillRefs({}),
                    instructions: ["Synthetic isolated test"],
                    provider: "openai",
                    model: "gpt-5.4-mini",
                    gateway: {
                        baseUrl: `http://127.0.0.1:${address.port}/v1`,
                        apiKey,
                    },
                    openAIApiMode: "chat-completions",
                }),
        );
        await Promise.allSettled(
            agents.map((agent) =>
                agent.run({
                    prompt: "Synthetic",
                    signal: AbortSignal.timeout(5000),
                }),
            ),
        );
        expect(keys.sort()).toEqual(["Bearer a-key", "Bearer b-key"]);
        expect(process.env.OPENAI_API_KEY).toBe("ambient-stale-key");
    } finally {
        if (original === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = original;
        await new Promise<void>((done) => server.close(() => done()));
    }
});
