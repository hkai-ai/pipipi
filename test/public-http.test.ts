import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createPinnedPublicHttpTransport,
    createPublicHttpTargetPolicy,
} from "../src/network/public-http.js";

let server: Server | undefined;

afterEach(async () => {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
});

describe("Public HTTP", () => {
    it("pins a bounded GET and returns its body", async () => {
        server = createServer((_request, response) => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"status":"ready"}');
        });
        const port = await listen(server);
        const resolveHostname = vi.fn(async () => [
            { address: "127.0.0.1", family: 4 as const },
        ]);
        const transport = createPinnedPublicHttpTransport({
            targetPolicy: createPublicHttpTargetPolicy({
                allowInsecureHttp: true,
                allowUnsafeAddresses: true,
                resolveHostname,
            }),
        });

        await expect(
            transport.request({
                url: `http://public.example:${port}/readyz`,
                method: "GET",
                headers: { accept: "application/json" },
                signal: AbortSignal.timeout(1_000),
                maxResponseBytes: 1_024,
            }),
        ).resolves.toEqual({
            status: 200,
            retryAfter: null,
            body: '{"status":"ready"}',
        });
        expect(resolveHostname).toHaveBeenCalledOnce();
    });

    it("rejects a response that crosses the byte limit in multiple chunks", async () => {
        server = createServer((_request, response) => {
            response.write("safe-");
            response.write("secret-value");
            response.end();
        });
        const port = await listen(server);
        const transport = localTransport();

        const result = await transport
            .request({
                url: `http://public.example:${port}/large`,
                method: "GET",
                headers: { accept: "application/json" },
                signal: AbortSignal.timeout(1_000),
                maxResponseBytes: 8,
            })
            .catch((error: unknown) => error);

        expect(result).toBeInstanceOf(Error);
        expect(JSON.stringify(result)).not.toContain("secret-value");
    });

    it("returns a redirect without following it", async () => {
        let requests = 0;
        server = createServer((_request, response) => {
            requests += 1;
            response.writeHead(302, {
                location: "http://169.254.169.254/latest/meta-data",
            });
            response.end();
        });
        const port = await listen(server);

        await expect(
            localTransport().request({
                url: `http://public.example:${port}/redirect`,
                method: "GET",
                headers: { accept: "application/json" },
                signal: AbortSignal.timeout(1_000),
                maxResponseBytes: 1_024,
            }),
        ).resolves.toMatchObject({ status: 302 });
        expect(requests).toBe(1);
    });
});

function localTransport() {
    return createPinnedPublicHttpTransport({
        targetPolicy: createPublicHttpTargetPolicy({
            allowInsecureHttp: true,
            allowUnsafeAddresses: true,
            resolveHostname: async () => [
                { address: "127.0.0.1", family: 4 as const },
            ],
        }),
    });
}

async function listen(target: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        target.once("error", reject);
        target.listen(0, "127.0.0.1", () => {
            target.off("error", reject);
            resolve();
        });
    });
    const address = target.address();
    if (!address || typeof address === "string") {
        throw new Error("Expected address");
    }
    return address.port;
}
