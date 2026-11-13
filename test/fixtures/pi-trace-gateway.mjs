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

function sendStream(
    response,
    model,
    item,
    inputTokens,
    outputTokens,
    thinking,
) {
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
    const reasoning = {
        id: "rs_local",
        type: "reasoning",
        summary: [{ type: "summary_text", text: thinking }],
    };
    const outputIndex = thinking ? 1 : 0;
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
        output: thinking ? [reasoning, item] : [item],
    };
    frame("response.created", {
        response: { ...result, status: "in_progress", output: [] },
    });
    if (thinking) {
        frame("response.output_item.added", {
            output_index: 0,
            item: { ...reasoning, summary: [] },
        });
        frame("response.reasoning_summary_text.delta", {
            output_index: 0,
            delta: thinking,
        });
        frame("response.output_item.done", {
            output_index: 0,
            item: reasoning,
        });
    }
    frame("response.output_item.added", {
        output_index: outputIndex,
        item: {
            ...item,
            status: "in_progress",
            ...(item.type === "message" ? { content: [] } : { arguments: "" }),
        },
    });
    frame("response.output_item.done", { output_index: outputIndex, item });
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
                await options.beforeRender?.();
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
                    adaptation: { entryIds: [], original: "雨狐为云撑伞" },
                }),
                215,
                42,
                options.thinking,
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
