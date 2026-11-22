/** 为异步角色与浏览器验收提供本地海报模型与成图替身，支持失败、延迟及调用次数核对。 */
import { createServer, type ServerResponse } from "node:http";

const marker = /case-label\[([^\]]{1,80})\]/u;

/** 生成携带用例标签的海报输入；标签经本地模型写入 Prompt，再由成图替身识别。 */
export function posterBrief(label: string) {
    return { brief: `本地验收海报 case-label[${label}]` } as const;
}

export function posterInterpretation(label: string) {
    return `Offline poster for ${label}`;
}

/**
 * 同时充当 OpenAI Responses 网关与内部 `POST /posters`，只在本机监听，
 * 不访问任何供应商；`fail-dependency` 标签让成图返回 503。
 */
export async function startPosterBusinessApi() {
    const effects = new Map<string, number>();
    const holds = new Map<string, Promise<void>>();
    const server = createServer(async (request, response) => {
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = Buffer.concat(chunks).toString("utf8");
            const label = marker.exec(body)?.[1];
            if (
                request.method === "POST" &&
                request.url === "/v1/responses" &&
                label
            ) {
                sendStream(response, JSON.parse(body).model, {
                    prompt: [
                        "Tall 3:5 aged paper, 82% negative space.",
                        `A single small torn-paper clipping marked case-label[${label}].`,
                        "Print in saturated cobalt ink at the edge.",
                        "Flat paper scan; avoid glossy mockups.",
                    ].join("\n\n"),
                    recipe: {
                        layout: "lower-left-float",
                        anchor: "torn-paper clipping",
                        typography: "archive microtext with date/weather",
                        accent: "saturated cobalt blue",
                        texture: "halftone degradation",
                        mood: "memory",
                    },
                    interpretation: posterInterpretation(label),
                });
                return;
            }
            if (
                request.method === "POST" &&
                request.url === "/posters" &&
                label
            ) {
                effects.set(label, (effects.get(label) ?? 0) + 1);
                await holds.get(label);
                if (label === "fail-dependency") {
                    sendJson(response, 503, {
                        error: { code: "POSTER_UNAVAILABLE" },
                    });
                    return;
                }
                sendJson(response, 200, {
                    url: "https://assets.example.test/posters/offline.png",
                    contentType: "image/png",
                    width: 600,
                    height: 1000,
                });
                return;
            }
            sendJson(response, 404, {});
        } catch {
            if (!response.headersSent) sendJson(response, 400, {});
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Expected a local HTTP address");
    const url = `http://127.0.0.1:${address.port}`;
    return {
        url,
        /** API 与 Worker 共用的本地模型和成图配置。 */
        environment: {
            CRT_BUSINESS_API_BASE_URL: url,
            MODEL_GATEWAY_BASE_URL: `${url}/v1`,
            MODEL_GATEWAY_API_KEY: "offline-test-key",
            OPENAI_API_MODE: "responses",
            PI_PROVIDER: "openai",
            PI_MODEL: "gpt-5.4",
        },
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            ),
        effectCount: (label: string) => effects.get(label) ?? 0,
        hold: (label: string) => {
            let release!: () => void;
            holds.set(
                label,
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
            );
            return release;
        },
    };
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
}

function sendStream(response: ServerResponse, model: string, value: unknown) {
    const item = {
        id: "msg_offline",
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
    const result = {
        id: "resp_offline",
        model,
        object: "response",
        status: "completed",
        usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
        output: [item],
    };
    response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
    });
    const frame = (type: string, data: Record<string, unknown>) =>
        response.write(
            `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
        );
    frame("response.created", {
        response: { ...result, status: "in_progress", output: [] },
    });
    frame("response.output_item.added", {
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
    });
    frame("response.output_item.done", { output_index: 0, item });
    frame("response.completed", { response: result });
    response.end();
}
