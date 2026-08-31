import { afterEach, describe, expect, it } from "vitest";
import {
    type ConstructedLocalAgentService,
    constructLocalAgentService,
} from "../src/app/local-agent.js";

describe("local Agent development service", () => {
    const services: ConstructedLocalAgentService[] = [];

    afterEach(async () => {
        await Promise.allSettled(
            services.splice(0).map(({ application }) => application.close()),
        );
    });

    it("serves the real v1 conversation contract without external services", async () => {
        const token = "test-local-agent-token";
        const service = constructLocalAgentService({
            PIPIPI_LOCAL_AGENT_ACCESS_TOKEN: token,
        });
        services.push(service);
        const { url } = await service.application.listen();

        const unauthorized = await fetch(`${url}/agent-conversations`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "idempotency-key": "unauthorized-open",
            },
            body: JSON.stringify({
                agent: { id: "design-assistant", version: "v1" },
                input: {
                    content: [{ type: "text", text: "未授权请求" }],
                },
            }),
        });
        expect(unauthorized.status).toBe(401);

        const opened = await fetch(`${url}/agent-conversations`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                "idempotency-key": "local-open-1",
            },
            body: JSON.stringify({
                agent: { id: "design-assistant", version: "v1" },
                input: {
                    content: [{ type: "text", text: "分析首页层级" }],
                },
            }),
        });
        expect(opened.status).toBe(202);
        const accepted = (await opened.json()) as {
            conversationId: string;
            turnId: string;
        };

        const first = await findSucceeded(url, token, accepted.conversationId);
        expect(first).toMatchObject({
            status: "ready",
            turnCount: 1,
            lastTurnId: accepted.turnId,
            turns: [
                {
                    status: "succeeded",
                    output: {
                        content: [
                            {
                                type: "text",
                                text: "本地联调回复（第 1 轮）：分析首页层级",
                            },
                        ],
                    },
                },
            ],
        });

        const continued = await fetch(
            `${url}/agent-conversations/${accepted.conversationId}/turns`,
            {
                method: "POST",
                headers: {
                    authorization: `Bearer ${token}`,
                    "content-type": "application/json",
                    "idempotency-key": "local-turn-2",
                },
                body: JSON.stringify({
                    afterTurnId: accepted.turnId,
                    input: {
                        content: [{ type: "text", text: "改成适合移动端" }],
                    },
                }),
            },
        );
        expect(continued.status).toBe(202);

        const second = await findSucceeded(
            url,
            token,
            accepted.conversationId,
            2,
        );
        expect(second).toMatchObject({
            status: "ready",
            turnCount: 2,
            turns: [
                {},
                {
                    status: "succeeded",
                    output: {
                        content: [
                            {
                                text: "本地联调回复（第 2 轮）：改成适合移动端",
                            },
                        ],
                    },
                },
            ],
        });
    });

    it("refuses to construct under production mode", () => {
        expect(() =>
            constructLocalAgentService({ NODE_ENV: "production" }),
        ).toThrow("cannot run in production");
    });
});

async function findSucceeded(
    url: string,
    token: string,
    conversationId: string,
    turnCount = 1,
) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await fetch(
            `${url}/agent-conversations/${conversationId}`,
            { headers: { authorization: `Bearer ${token}` } },
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            status: string;
            turnCount: number;
        };
        if (body.status === "ready" && body.turnCount === turnCount) {
            return body;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Local Agent Turn did not reach a terminal state");
}
