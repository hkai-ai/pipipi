import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createProcessingApplication } from "../src/api/application.js";
import type {
    ConsoleCallerKeys,
    ConsoleIssuedKey,
} from "../src/api/console-contract.js";
import { createCompositeCallerIdentityResolver } from "../src/api/identity.js";
import { hashCallerApiKey } from "../src/caller-api-keys/index.js";
import { createInMemoryCallerApiKeyStore } from "../src/caller-api-keys/memory.js";
import { createAsyncProcessRuns } from "../src/process-runs/index.js";
import { createInMemoryProcessRunStore } from "../src/process-runs/store/index.js";
import {
    createProcessRegistry,
    createProcessRunner,
    defineProcessRegistration,
} from "../src/process-runtime/index.js";
import { createInMemoryProcessRunRecords } from "../src/process-runtime/records.js";

const base = "/ops-secret";
const keysPath = `${base}/caller-keys`;
const metadata = { callerId: "memebuy-uat", label: "Backend UAT" };
const processBody = { process: "test", version: "v1", input: {} };
const apps: ReturnType<typeof createProcessingApplication>[] = [];

afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function start() {
    let now = new Date("2026-11-17T00:00:00Z");
    const keys = createInMemoryCallerApiKeyStore({ clock: () => now });
    const records = createInMemoryProcessRunRecords();
    const registry = createProcessRegistry([
        defineProcessRegistration({
            id: "test",
            version: "v1",
            inputSchema: z.object({}),
            outputSchema: z.object({}),
            execute: async () => ({}),
        }),
    ]);
    const identity = createCompositeCallerIdentityResolver({ store: keys });
    const auth = {
        persistent: false,
        executeAuthMode: "required",
        gatewayFallbackEnabled: false,
    } as const;
    const logs: unknown[] = [];
    const app = createProcessingApplication({
        executor: createProcessRunner({ registry, runRecords: records }),
        http: {
            callerIdentity: identity,
            executeAuthMode: auth.executeAuthMode,
            logSink: (entry) => logs.push(entry),
            maxRequestBodyBytes: 4096,
            console: {
                basePath: base,
                assetDirectory: "unused",
                records: {
                    list: async () => ({ records: [] }),
                    find: records.find,
                },
                callerKeys: { ...auth, store: keys },
            },
            asyncProcessRuns: {
                callerIdentity: identity,
                readiness: async () => {},
                runs: createAsyncProcessRuns({
                    registry,
                    store: createInMemoryProcessRunStore(),
                }),
            },
        },
    });
    apps.push(app);
    const { url } = await app.listen();
    const headers = {
        "content-type": "application/json; charset=utf-8",
        "x-pipipi-console-action": "1",
        "sec-fetch-site": "same-origin",
        origin: new URL(url).origin,
    };
    const post = (
        path: string,
        body: unknown,
        options = new Headers(headers),
    ) =>
        fetch(`${url}${path}`, {
            method: "POST",
            headers: options,
            body: JSON.stringify(body),
        });
    return {
        auth,
        keys,
        records,
        logs,
        url,
        headers,
        post,
        setNow: (value: string) => {
            now = new Date(value);
        },
    };
}

async function expectFailure(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
        status: "failed",
        error: { code },
    });
    return text;
}

describe("Console caller keys", () => {
    it("issues, inventories, authenticates and immediately revokes one key through a custom base path", async () => {
        const f = await start();
        await f.keys.issue({ callerId: "other", label: "other" });
        const expired = await f.keys.issue({
            ...metadata,
            expiresAt: "2026-11-17T00:01:00Z",
        });
        f.setNow("2026-11-17T00:01:00Z");
        const expiresAt = "2026-11-18T00:00:00.000Z";
        const issue = await f.post(keysPath, {
            ...metadata,
            actor: "operator",
            note: "rotation",
            expiresAt,
        });
        expect(issue.status).toBe(201);
        expect(issue.headers.get("cache-control")).toBe("no-store");
        const {
            key,
            metadata: issued,
            persistent,
        } = (await issue.json()) as ConsoleIssuedKey;
        expect(key).toMatch(/^ppk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
        expect(persistent).toBe(false);
        expect(issued).toMatchObject({ ...metadata, expiresAt });

        const list = async () => {
            const response = await fetch(
                `${f.url}${keysPath}?callerId=memebuy-uat`,
            );
            expect(response.status).toBe(200);
            expect(response.headers.get("cache-control")).toBe("no-store");
            const text = await response.text();
            expect(text).not.toContain(key);
            expect(text).not.toContain(hashCallerApiKey(key));
            return JSON.parse(text) as ConsoleCallerKeys;
        };
        const initial = await list();
        expect(initial.auth).toEqual(f.auth);
        expect(initial.keys).toEqual([
            { ...issued, status: "active" },
            { ...expired.metadata, status: "expired" },
        ]);
        expect(initial.audits).toHaveLength(2);
        expect(initial.audits[0]).toMatchObject({
            operation: "issue",
            keyId: issued.keyId,
            actor: "operator",
            note: "rotation",
            expiresAt,
        });

        const callBusiness = (path: string) =>
            f.post(
                path,
                processBody,
                new Headers({
                    "content-type": "application/json",
                    authorization: `Bearer ${key}`,
                    "idempotency-key": "console-test",
                }),
            );
        const execution = await callBusiness("/execute");
        expect(execution.status).toBe(200);
        const { runId } = await execution.json();
        const record = await f.records.find(runId);
        expect(record).toMatchObject({
            callerId: metadata.callerId,
            authMethod: "api_key",
        });
        expect(JSON.stringify(record)).not.toContain(key);
        expect((await callBusiness("/process-runs")).status).toBe(202);
        expect((await list()).keys[0]).toMatchObject({
            lastUsedAt: "2026-11-17T00:01:00.000Z",
        });

        const revokePath = `${keysPath}/${issued.keyId}/revoke`;
        const revoke = await f.post(revokePath, {
            actor: "operator",
            note: "retired",
        });
        expect(revoke.status).toBe(200);
        expect(revoke.headers.get("cache-control")).toBe("no-store");
        expect(await revoke.json()).toEqual({ revoked: true });
        await expectFailure(await f.post(revokePath, {}), 404, "KEY_NOT_FOUND");
        await expectFailure(
            await f.post(
                `${keysPath}/00000000-0000-4000-8000-000000000001/revoke`,
                {},
            ),
            404,
            "KEY_NOT_FOUND",
        );
        const revoked = await list();
        expect(revoked.keys[0]).toMatchObject({
            status: "revoked",
            revokedAt: "2026-11-17T00:01:00.000Z",
        });
        expect(revoked.audits).toHaveLength(3);
        expect(revoked.audits[0]).toMatchObject({
            operation: "revoke",
            keyId: issued.keyId,
            note: "retired",
            expiresAt,
        });
        for (const path of ["/execute", "/process-runs"]) {
            const body = await expectFailure(
                await callBusiness(path),
                401,
                "CALLER_UNAUTHORIZED",
            );
            expect(body).not.toContain(key);
        }
        expect(JSON.stringify(f.logs)).not.toContain(key);
        expect(JSON.stringify(f.logs)).not.toContain(hashCallerApiKey(key));
    });

    it("rejects invalid write headers and oversized bodies without issuing or revoking", async () => {
        const f = await start();
        const existing = await f.keys.issue(metadata);
        const cases = [
            ["x-pipipi-console-action", null, 403, "FORBIDDEN"],
            ["x-pipipi-console-action", "0", 403, "FORBIDDEN"],
            ["sec-fetch-site", "cross-site", 403, "FORBIDDEN"],
            ["sec-fetch-site", "same-site", 403, "FORBIDDEN"],
            ["origin", "https://elsewhere.example", 403, "FORBIDDEN"],
            ["origin", `${f.headers.origin}/path`, 403, "FORBIDDEN"],
            ["origin", "null", 403, "FORBIDDEN"],
            ["content-type", "text/plain", 415, "UNSUPPORTED_MEDIA_TYPE"],
        ] as const;
        for (const path of [
            keysPath,
            `${keysPath}/${existing.metadata.keyId}/revoke`,
        ]) {
            for (const [header, value, status, code] of cases) {
                const headers = new Headers(f.headers);
                if (value === null) headers.delete(header);
                else headers.set(header, value);
                const response = await f.post(path, metadata, headers);
                expect(response.headers.get("cache-control")).toBe("no-store");
                await expectFailure(response, status, code);
            }
            await expectFailure(
                await f.post(path, { note: "x".repeat(4096) }),
                413,
                "REQUEST_TOO_LARGE",
            );
        }
        const preflight = await fetch(f.url + keysPath, {
            method: "OPTIONS",
            headers: {
                origin: "https://elsewhere.example",
                "access-control-request-method": "POST",
                "access-control-request-headers": "x-pipipi-console-action",
            },
        });
        await expectFailure(preflight, 404, "ROUTE_NOT_FOUND");
        expect(preflight.headers.has("access-control-allow-origin")).toBe(
            false,
        );
        expect(await f.keys.list()).toEqual([
            { ...existing.metadata, status: "active" },
        ]);
        expect(await f.keys.audits()).toHaveLength(1);
    });

    it("uses a single forwarded host from a loopback proxy for origin validation", async () => {
        const f = await start();
        const publicHost = "pi.ganjiuwanshi.com";
        const publicOrigin = `https://${publicHost}`;
        const post = (
            origin: string,
            forwardedHost: string | string[],
            site = "same-origin",
        ) =>
            new Promise<Response>((resolve, reject) => {
                const req = request(
                    f.url + keysPath,
                    {
                        method: "POST",
                        headers: {
                            ...f.headers,
                            host: "127.0.0.1:4300",
                            origin,
                            "sec-fetch-site": site,
                            "x-forwarded-host": forwardedHost,
                        },
                    },
                    async (response) => {
                        try {
                            const body = await response.toArray();
                            resolve(
                                new Response(Buffer.concat(body), {
                                    status: response.statusCode,
                                }),
                            );
                        } catch (error) {
                            reject(error);
                        }
                    },
                );
                req.on("error", reject);
                req.end(JSON.stringify(metadata));
            });

        const rejected = [
            await post("https://elsewhere.example", publicHost),
            await post("http://127.0.0.1:4300", publicHost),
            await post(publicOrigin, [publicHost, publicHost]),
            await post(publicOrigin, `${publicHost}, ${publicHost}`),
            await post(publicOrigin, publicHost, "cross-site"),
        ];
        for (const response of rejected)
            await expectFailure(response, 403, "FORBIDDEN");

        expect(await f.keys.list()).toEqual([]);
        const issued = await post(publicOrigin, publicHost);
        expect(issued.status).toBe(201);
        expect(await issued.json()).toMatchObject({ metadata });
        expect(await f.keys.list()).toHaveLength(1);
    });

    it("validates filters and inputs while preserving 404 on existing read routes", async () => {
        const f = await start();
        for (const callerId of ["", "  ", "界".repeat(171)]) {
            await expectFailure(
                await fetch(
                    `${f.url}${keysPath}?${new URLSearchParams({ callerId })}`,
                ),
                400,
                "INVALID_INPUT",
            );
        }
        for (const input of [
            { ...metadata, label: " " },
            { ...metadata, actor: 10 },
            { ...metadata, expiresAt: "2026-11-17T00:00:00Z" },
            { ...metadata, expiresAt: "2026-11-18" },
            ["not an object"],
        ]) {
            await expectFailure(
                await f.post(keysPath, input),
                400,
                "INVALID_INPUT",
            );
        }
        for (const path of [
            base,
            `${base}/runs`,
            `${base}/processes`,
            "/console/caller-keys",
        ]) {
            await expectFailure(await f.post(path, {}), 404, "ROUTE_NOT_FOUND");
        }
        expect(await f.keys.list()).toEqual([]);
        expect(await f.keys.audits()).toEqual([]);

        const existing = await f.keys.issue(metadata);
        const body = await expectFailure(
            await f.post(`${keysPath}/${existing.metadata.keyId}/revoke`, {
                note: `Bearer ${existing.key}`,
            }),
            400,
            "INVALID_INPUT",
        );
        expect(body + JSON.stringify(f.logs)).not.toContain(existing.key);
        expect(await f.keys.audits()).toHaveLength(1);
        const headers = new Headers(f.headers);
        headers.delete("origin");
        headers.set("sec-fetch-site", "none");
        expect(
            (
                await f.post(
                    `${keysPath}/${existing.metadata.keyId}/revoke`,
                    {},
                    headers,
                )
            ).status,
        ).toBe(200);
    });
});
