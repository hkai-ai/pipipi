/** 验证 production Agent Resource HTTP Adapter 的受信请求、边界与错误净化 */
import { createServer, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { HttpOwnedAgentResourceService } from "../src/agent-conversations/resource.http.js";

const sharedSecret = "resource-service-secret-at-least-32-bytes";
const closeServers: Array<() => Promise<void>> = [];

afterEach(async () => {
    await Promise.all(closeServers.splice(0).map((close) => close()));
});

describe("Agent Resource HTTP Adapter", () => {
    it("uses only the fixed internal routes and bearer credential", async () => {
        const seen: Array<{
            method: string | undefined;
            url: string | undefined;
            authorization: string | undefined;
            body: unknown;
        }> = [];
        const baseUrl = await startResourceService(async (request) => {
            const body = await requestBody(request);
            seen.push({
                method: request.method,
                url: request.url,
                authorization: request.headers.authorization,
                body,
            });
            if (request.url === "/readyz") return {};
            if (request.url === "/agent-resources/model-content") {
                return { mediaType: "image/png", data: "cG5n" };
            }
            if (request.url === "/agent-resources/read-projection") {
                return {
                    url: "https://resources.example/temporary",
                    expiresAt: "2026-08-30T10:00:00.000Z",
                };
            }
            if (request.url === "/agent-resources/process-output") {
                return {
                    invocation: 1,
                    process: "minimal-zine-poster",
                    version: "v1",
                    status: "succeeded",
                    output: { image: { resourceId: "output-1" } },
                };
            }
            return {
                resourceId: "image-1",
                mediaType: "image/png",
                byteSize: 3,
                width: 1,
                height: 1,
            };
        });
        const service = new HttpOwnedAgentResourceService({
            baseUrl,
            sharedSecret,
        });

        await service.ready();
        await service.inspect({
            ownerId: "caller-a",
            resourceId: "image-1",
            purpose: "input",
        });
        await service.readModelContent({
            ownerId: "caller-a",
            resourceId: "image-1",
            signal: new AbortController().signal,
        });
        await service.createReadProjection({
            ownerId: "caller-a",
            resourceId: "image-1",
        });
        await service.publishProcessOutput({
            ownerId: "caller-a",
            turnId: "turn-1",
            toolName: "create_zine_poster",
            result: {
                invocation: 1,
                process: "minimal-zine-poster",
                version: "v1",
                status: "succeeded",
                output: { image: { url: "https://images.example/poster.png" } },
            },
        });

        expect(seen.map(({ method, url }) => ({ method, url }))).toEqual([
            { method: "GET", url: "/readyz" },
            { method: "POST", url: "/agent-resources/inspect" },
            { method: "POST", url: "/agent-resources/model-content" },
            { method: "POST", url: "/agent-resources/read-projection" },
            { method: "POST", url: "/agent-resources/process-output" },
        ]);
        expect(
            seen.every(
                (request) => request.authorization === `Bearer ${sharedSecret}`,
            ),
        ).toBe(true);
        expect(seen[2]?.body).toEqual({
            ownerId: "caller-a",
            resourceId: "image-1",
        });
    });

    it("rejects weak credentials and hides upstream error bodies", async () => {
        expect(
            () =>
                new HttpOwnedAgentResourceService({
                    baseUrl: "https://resources.example",
                    sharedSecret: "short",
                }),
        ).toThrow(
            "AGENT_RESOURCE_SERVICE_SHARED_SECRET must be at least 32 bytes",
        );
        const baseUrl = await startResourceService(
            async () => ({ providerSecret: "must-not-escape" }),
            500,
        );
        const service = new HttpOwnedAgentResourceService({
            baseUrl,
            sharedSecret,
        });

        await expect(service.ready()).rejects.toThrow(
            "Agent Resource Service returned an error",
        );
        await expect(service.ready()).rejects.not.toThrow("must-not-escape");
    });

    it("rejects non-root service URLs and oversized responses", async () => {
        expect(
            () =>
                new HttpOwnedAgentResourceService({
                    baseUrl: "https://resources.example/prefix",
                    sharedSecret,
                }),
        ).toThrow("AGENT_RESOURCE_SERVICE_BASE_URL is invalid");
        const baseUrl = await startResourceService(async () => ({
            value: "x".repeat(70_000),
        }));
        const service = new HttpOwnedAgentResourceService({
            baseUrl,
            sharedSecret,
        });

        await expect(service.ready()).rejects.toThrow(
            "Agent Resource Service response is too large",
        );
    });
});

async function startResourceService(
    handler: (request: IncomingMessage) => Promise<unknown>,
    status = 200,
): Promise<string> {
    const server = createServer((request, response) => {
        void handler(request).then((body) => {
            response.writeHead(status, { "content-type": "application/json" });
            response.end(JSON.stringify(body));
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    closeServers.push(
        () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Expected an IP server address");
    }
    return `http://127.0.0.1:${address.port}`;
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    return text.length === 0 ? undefined : JSON.parse(text);
}
