import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import {
    createDevelopmentGateway,
    developmentGatewayCallerId,
} from "../console/development-gateway.js";
import {
    callerIdentityHeader,
    gatewayAuthenticationHeader,
} from "../src/api/identity.js";

describe("Console development Gateway", () => {
    const sharedSecret = "development-gateway-secret-at-least-32-bytes";
    const httpServers: Server[] = [];
    const viteServers: ViteDevServer[] = [];

    afterEach(async () => {
        await Promise.allSettled(
            viteServers.splice(0).map((server) => server.close()),
        );
        await Promise.allSettled(httpServers.splice(0).map(closeHttpServer));
    });

    it("stays disabled unless explicitly enabled", () => {
        expect(
            createDevelopmentGateway({
                command: "serve",
                mode: "development",
                environment: {},
            }),
        ).toBeUndefined();
    });

    it.each([
        { command: "build" as const, mode: "development", nodeEnv: undefined },
        { command: "serve" as const, mode: "production", nodeEnv: undefined },
        {
            command: "serve" as const,
            mode: "development",
            nodeEnv: "production",
        },
    ])(
        "rejects an enabled Gateway for $command/$mode/$nodeEnv",
        ({ command, mode, nodeEnv }) => {
            expect(() =>
                createDevelopmentGateway({
                    command,
                    mode,
                    environment: {
                        CONSOLE_DEVELOPMENT_GATEWAY_ENABLED: "true",
                        ASYNC_GATEWAY_SHARED_SECRET: sharedSecret,
                        NODE_ENV: nodeEnv,
                    },
                }),
            ).toThrow("only available from the development server");
        },
    );

    it("rejects a non-loopback upstream before holding its credential", () => {
        expect(() =>
            createDevelopmentGateway({
                command: "serve",
                mode: "development",
                environment: {
                    CONSOLE_DEVELOPMENT_GATEWAY_ENABLED: "true",
                    CONSOLE_DEVELOPMENT_GATEWAY_TARGET:
                        "https://api.example.com",
                    ASYNC_GATEWAY_SHARED_SECRET: sharedSecret,
                },
            }),
        ).toThrow("loopback HTTP origin");
    });

    it("removes browser identity headers and injects its fixed identity", async () => {
        let receivedHeaders: Record<string, string | string[] | undefined> = {};
        const upstream = createHttpServer((request, response) => {
            receivedHeaders = request.headers;
            response.writeHead(202, {
                "content-type": "application/json",
                location: "/process-runs/run-gateway",
            });
            response.end(JSON.stringify({ accepted: true }));
        });
        httpServers.push(upstream);
        const target = await listenHttpServer(upstream);
        const proxy = createDevelopmentGateway({
            command: "serve",
            mode: "development",
            environment: {
                CONSOLE_DEVELOPMENT_GATEWAY_ENABLED: "true",
                CONSOLE_DEVELOPMENT_GATEWAY_TARGET: target,
                ASYNC_GATEWAY_SHARED_SECRET: sharedSecret,
            },
        });
        if (!proxy) throw new Error("Expected a development Gateway");
        expect(JSON.stringify(proxy)).not.toContain(sharedSecret);
        expect(JSON.stringify(proxy)).not.toContain(developmentGatewayCallerId);

        const gateway = await createViteServer({
            configFile: false,
            logLevel: "silent",
            server: {
                host: "127.0.0.1",
                port: 0,
                proxy: { "/process-runs": proxy },
            },
        });
        viteServers.push(gateway);
        await gateway.listen();
        const gatewayUrl = listeningUrl(gateway.httpServer);

        const response = await fetch(`${gatewayUrl}/process-runs`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                [callerIdentityHeader]: "attacker",
                [gatewayAuthenticationHeader]: "attacker-secret",
            },
            body: JSON.stringify({ process: "content-processing" }),
        });

        expect(response.status).toBe(202);
        expect(receivedHeaders[callerIdentityHeader]).toBe(
            developmentGatewayCallerId,
        );
        expect(receivedHeaders[gatewayAuthenticationHeader]).toBe(sharedSecret);
        const responseBody = await response.text();
        expect(responseBody).not.toContain(sharedSecret);
        expect(responseBody).not.toContain(developmentGatewayCallerId);
    });
});

async function listenHttpServer(server: Server): Promise<string> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    return listeningUrl(server);
}

function listeningUrl(
    server: { address(): ReturnType<Server["address"]> } | null,
): string {
    const address = server?.address();
    if (!address || typeof address === "string") {
        throw new Error("Expected an HTTP server address");
    }
    return `http://127.0.0.1:${address.port}`;
}

async function closeHttpServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
}
