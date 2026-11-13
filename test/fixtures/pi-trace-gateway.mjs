/** 本地 Responses 与图片服务替身，仅根据本次请求输出确定性的表情包协议响应。 */
import { createServer } from "node:http";

function sendJson(response, value, status = 200) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
}

function finalMessage(value) {
    return {
        id: "msg_demo",
        type: "message",
        role: "assistant",
        phase: "final_answer",
        status: "completed",
        content: [
            {
                type: "output_text",
                text: JSON.stringify(value),
                annotations: [],
            },
        ],
    };
}

function sendStream(response, model, item, inputTokens, outputTokens) {
    response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
    });
    const frame = (type, data) =>
        response.write(
            "event: " +
                type +
                "\ndata: " +
                JSON.stringify({ type, ...data }) +
                "\n\n",
        );
    const result = {
        id: `resp_demo_${item.id}`,
        model,
        object: "response",
        status: "completed",
        usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
        },
        output: [item],
    };
    frame("response.created", {
        response: { ...result, status: "in_progress", output: [] },
    });
    frame("response.output_item.added", {
        output_index: 0,
        item: {
            ...item,
            status: "in_progress",
            ...(item.type === "message" ? { content: [] } : { arguments: "" }),
        },
    });
    frame("response.output_item.done", { output_index: 0, item });
    frame("response.completed", { response: result });
    response.end();
}

export async function startDemoGateway(fixture, useSearch, options = {}) {
    const counts = { plan: 0, search: 0, render: 0 };
    const server = createServer(async (request, response) => {
        try {
            const body = [];
            for await (const chunk of request) body.push(chunk);
            const input = JSON.parse(Buffer.concat(body).toString("utf8"));
            if (request.method === "POST" && request.url === "/posters") {
                counts.render++;
                return sendJson(response, {
                    ...fixture.output.image,
                    width: 1024,
                    height: 1696,
                });
            }
            if (
                request.method === "POST" &&
                request.url === "/v1/responses" &&
                input.model === "gpt-5.4"
            ) {
                counts.plan++;
                if (input.tools?.length)
                    throw new Error("unexpected tools on poster request");
                return sendStream(
                    response,
                    input.model,
                    finalMessage({
                        prompt: "Tall 3:5 aged paper, 82% negative space.\n\nA single small torn-paper clipping.\n\nPrint in saturated cobalt ink at the edge.\n\nFlat paper scan; avoid glossy mockups.",
                        recipe: {
                            layout: "lower-left-float",
                            anchor: "torn-paper clipping",
                            typography: "archive microtext with date/weather",
                            accent: "saturated cobalt blue",
                            texture: "halftone degradation",
                            mood: "memory",
                        },
                        interpretation: "A quiet paper archive.",
                    }),
                    50,
                    20,
                );
            }
            if (
                request.method === "POST" &&
                request.url === "/character-emojis/v4"
            ) {
                if (
                    !request.headers["idempotency-key"] ||
                    input.imageUrls?.length !== 1
                )
                    throw new Error("unexpected render");
                counts.render++;
                return sendJson(response, fixture.output.image);
            }
            if (request.method !== "POST" || request.url !== "/v1/responses")
                return sendJson(response, {}, 404);
            if (
                input.model === "deepseek-v4-flash-260425" &&
                input.stream === false
            ) {
                if (
                    input.tool_choice !== "required" ||
                    !input.tools.some((t) => t.type === "web_search")
                )
                    throw new Error("unexpected search");
                counts.search++;
                if (options.scenario === "search-failure")
                    return sendJson(
                        response,
                        { error: "private dependency failure" },
                        503,
                    );
                return sendJson(response, {
                    status: "completed",
                    output: [
                        { type: "web_search_call", status: "completed" },
                        finalMessage({
                            entries: [],
                            insufficiency:
                                "本地演示无可引用的社区梗，按给定题材原创。",
                        }),
                    ],
                });
            }
            if (input.model !== "deepseek-v4.1-flash" || input.stream !== true)
                throw new Error("unexpected model");
            counts.plan++;
            await options.beforePlan?.();
            if (response.destroyed) return;
            if (
                useSearch &&
                input.tools?.some((tool) => tool.name === "search_memes")
            ) {
                return sendStream(
                    response,
                    input.model,
                    {
                        id: "fc_demo",
                        type: "function_call",
                        call_id: "call_demo",
                        name: "search_memes",
                        status: "completed",
                        arguments: JSON.stringify({ focus: "雨狐给云撑伞" }),
                    },
                    180,
                    18,
                );
            }
            if (
                useSearch &&
                !input.input.some(
                    (message) => message.type === "function_call_output",
                )
            )
                throw new Error("missing tool result");
            return sendStream(
                response,
                input.model,
                finalMessage({
                    ...fixture.output.plan,
                    ...(options.scenario === "repair-rejected" ||
                    (options.scenario === "repair" && counts.plan === 1)
                        ? { caption: "错字" }
                        : {}),
                    adaptation: { entryIds: [], original: "雨狐为云撑伞" },
                }),
                215,
                42,
            );
        } catch (error) {
            console.error("[local gateway]", error.message);
            sendJson(response, { error: { code: "demo_fixture_error" } }, 500);
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        counts,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}
