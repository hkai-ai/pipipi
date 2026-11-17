import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgentConversations } from "../src/agent-conversations/index.js";
import { createInMemoryAgentTurnQueue } from "../src/agent-conversations/queue.js";
import { defineAgentRegistration } from "../src/agent-conversations/registration.js";
import { createAgentRegistry } from "../src/agent-conversations/registry.js";
import { createInMemoryAgentConversationStore } from "../src/agent-conversations/store.js";
import { createProcessingApplication } from "../src/api/application.js";
import {
    type CallerIdentityResolver,
    createCompositeCallerIdentityResolver,
    createGatewayCallerIdentityResolver,
} from "../src/api/identity.js";
import { runCallerApiKeys } from "../src/caller-api-keys/cli.js";
import { createInMemoryCallerApiKeyStore } from "../src/caller-api-keys/memory.js";
import { createAsyncProcessRuns } from "../src/process-runs/index.js";
import { createInMemoryProcessRunStore } from "../src/process-runs/store/index.js";
import {
    createProcessRegistry,
    createProcessRunner,
    defineProcessRegistration,
} from "../src/process-runtime/index.js";
import { createInMemoryProcessRunRecords } from "../src/process-runtime/records.js";

const apps: { close: () => Promise<void> }[] = [];
afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
});
const body = {
    process: "test",
    version: "v1",
    input: { value: "private-input" },
};
async function fixture(
    mode: "open" | "audit" | "required" = "required",
    fallback = false,
    resolver?: CallerIdentityResolver,
) {
    let now = new Date("2026-11-17T00:00:00Z");
    const keys = createInMemoryCallerApiKeyStore({ clock: () => now });
    const old = await keys.issue({ callerId: "memebuy", label: "old" });
    const registry = createProcessRegistry([
        defineProcessRegistration({
            id: "test",
            version: "v1",
            inputSchema: z.object({ value: z.string() }),
            outputSchema: z.object({ value: z.string() }),
            execute: async (input) => input,
        }),
    ]);
    const records = createInMemoryProcessRunRecords();
    const identity =
        resolver ??
        createCompositeCallerIdentityResolver({
            store: keys,
            gateway: fallback
                ? createGatewayCallerIdentityResolver({
                      sharedSecret: "gateway-secret-at-least-thirty-two-bytes",
                  })
                : undefined,
        });
    const logs: unknown[] = [];
    const conversations = createAgentConversations({
        registry: createAgentRegistry([
            defineAgentRegistration({
                id: "test-agent",
                version: "v1",
                revision: "test",
                agent: {
                    respond: async () => ({
                        content: [{ type: "text", text: "ok" }],
                    }),
                },
            }),
        ]),
        store: createInMemoryAgentConversationStore(),
        queue: createInMemoryAgentTurnQueue(),
    });
    const app = createProcessingApplication({
        executor: createProcessRunner({ registry, runRecords: records }),
        http: {
            callerIdentity: identity,
            executeAuthMode: mode,
            logSink: (entry) => logs.push(entry),
            asyncProcessRuns: {
                callerIdentity: identity,
                readiness: async () => {},
                runs: createAsyncProcessRuns({
                    registry,
                    store: createInMemoryProcessRunStore(),
                }),
            },
            agentConversations: { callerIdentity: identity, conversations },
        },
    });
    apps.push(app);
    const { url } = await app.listen();
    const call = (
        path: string,
        key?: string,
        extra: Record<string, string> = {},
        value: unknown = body,
        method = "POST",
    ) =>
        fetch(`${url}${path}`, {
            method,
            headers: {
                "content-type": "application/json",
                "idempotency-key": "stable",
                ...(key ? { authorization: `Bearer ${key}` } : {}),
                ...extra,
            },
            ...(method === "POST" ? { body: JSON.stringify(value) } : {}),
        });
    return {
        keys,
        old,
        records,
        logs,
        call,
        setNow: (date: string) => {
            now = new Date(date);
        },
    };
}
it("uses one key across sync, async and conversations; rotation preserves ownership and idempotency", async () => {
    const f = await fixture();
    const sync = await f.call("/execute", f.old.key);
    expect(sync.status).toBe(200);
    const result = await sync.json();
    expect(await f.records.find(result.runId)).toMatchObject({
        callerId: "memebuy",
        authMethod: "api_key",
    });
    const accepted = await f.call("/process-runs", f.old.key);
    expect(accepted.status).toBe(202);
    const run = await accepted.json();
    const conversationBody = {
        agent: { id: "test-agent", version: "v1" },
        input: { content: [{ type: "text", text: "hello" }] },
    };
    const opened = await f.call(
        "/agent-conversations",
        f.old.key,
        {},
        conversationBody,
    );
    expect(opened.status).toBe(202);
    const conversation = await opened.json();
    const next = await f.keys.issue({ callerId: "memebuy", label: "next" });
    await f.keys.revoke(f.old.metadata.keyId);
    expect(
        (
            await f.call(
                `/process-runs/${run.runId}`,
                next.key,
                {},
                undefined,
                "GET",
            )
        ).status,
    ).toBe(200);
    expect(
        await (await f.call("/process-runs", next.key)).json(),
    ).toMatchObject({ runId: run.runId });
    expect(
        (
            await f.call(
                `/agent-conversations/${conversation.conversationId}`,
                next.key,
                {},
                undefined,
                "GET",
            )
        ).status,
    ).toBe(200);
    const other = await f.keys.issue({ callerId: "other", label: "other" });
    expect(
        (
            await f.call(
                `/process-runs/${run.runId}`,
                other.key,
                {},
                undefined,
                "GET",
            )
        ).status,
    ).toBe(404);
    expect(f.logs).toEqual(
        expect.arrayContaining([
            expect.objectContaining({
                event: "process_run_submission_accepted",
                authMethod: "api_key",
            }),
        ]),
    );
});
it.each(["/execute", "/process-runs", "/agent-conversations"])(
    "rejects absent, invalid, revoked and expired keys at %s without echoing secrets",
    async (path) => {
        const f = await fixture();
        const expired = await f.keys.issue({
            callerId: "memebuy",
            label: "expired",
            expiresAt: "2026-11-17T00:01:00Z",
        });
        f.setNow("2026-11-17T00:01:00Z");
        await f.keys.revoke(f.old.metadata.keyId);
        for (const key of [undefined, "ppk_invalid", f.old.key, expired.key]) {
            const response = await f.call(path, key, {
                "x-pipipi-caller-id": "forged",
                "x-pipipi-gateway-token": "forged",
            });
            expect(response.status).toBe(401);
            const text = await response.text();
            expect(text).toContain("CALLER_UNAUTHORIZED");
            if (key) expect(text + JSON.stringify(f.logs)).not.toContain(key);
        }
    },
);
it("accepts legacy Bearer gateway fallback but never falls back for an invalid Pipipi key", async () => {
    const f = await fixture("required", true);
    const gateway = {
        "x-pipipi-caller-id": "legacy",
        "x-pipipi-gateway-token": "gateway-secret-at-least-thirty-two-bytes",
    };
    for (const token of [undefined, "legacy-token"])
        expect((await f.call("/execute", token, gateway)).status).toBe(200);
    expect((await f.call("/execute", "ppk_invalid", gateway)).status).toBe(401);
    const valid = await f.call("/execute", f.old.key, gateway);
    expect(await f.records.find((await valid.json()).runId)).toMatchObject({
        callerId: "memebuy",
        authMethod: "api_key",
    });
    const disabled = await fixture();
    expect(
        (await disabled.call("/execute", "legacy-token", gateway)).status,
    ).toBe(401);
});
it("open never resolves identity; audit logs only safe anonymous metadata and records valid callers", async () => {
    const resolve = vi.fn(async () => {
        throw new Error("secret database error");
    });
    const open = await fixture("open", false, { resolve });
    for (const key of [undefined, open.old.key]) {
        const response = await open.call("/execute", key);
        expect(response.status).toBe(200);
        const record = await open.records.find((await response.json()).runId);
        expect(record).toBeDefined();
        expect(record).not.toHaveProperty("callerId");
        expect(record).not.toHaveProperty("authMethod");
    }
    for (const log of open.logs) {
        expect(log).not.toHaveProperty("callerId");
        expect(log).not.toHaveProperty("authMethod");
    }
    expect(resolve).not.toHaveBeenCalled();
    const audit = await fixture("audit", false, { resolve });
    const anonymous = await audit.call("/execute", "ppk_secret", {
        "x-request-id": "trace-001",
    });
    expect(anonymous.status).toBe(200);
    const anonymousRecord = await audit.records.find(
        (await anonymous.json()).runId,
    );
    expect(anonymousRecord).toBeDefined();
    expect(anonymousRecord).toHaveProperty("authMethod", "anonymous");
    expect(anonymousRecord).not.toHaveProperty("callerId");
    expect(audit.logs).toContainEqual({
        event: "execute_anonymous",
        timestamp: expect.any(String),
        path: "/execute",
        process: "test",
        version: "v1",
        requestId: "trace-001",
        authMethod: "anonymous",
    });
    expect(JSON.stringify(audit.logs)).not.toMatch(
        /private-input|ppk_secret|secret database/,
    );
    const valid = await fixture("audit");
    const result = await (await valid.call("/execute", valid.old.key)).json();
    expect(await valid.records.find(result.runId)).toMatchObject({
        callerId: "memebuy",
    });
    expect(valid.logs).not.toEqual(
        expect.arrayContaining([
            expect.objectContaining({ event: "execute_anonymous" }),
        ]),
    );
    const required = await fixture("required", false, { resolve });
    expect((await required.call("/execute", "ppk_secret")).status).toBe(503);
});
it("CLI issue -> HTTP -> list without secret -> revoke -> 401", async () => {
    const f = await fixture();
    const issued = (await runCallerApiKeys(
        [
            "issue",
            "--caller-id",
            "cli-caller",
            "--label",
            "integration",
            "--actor",
            "test",
        ],
        f.keys,
    )) as { key: string; metadata: { keyId: string } };
    expect((await f.call("/execute", issued.key)).status).toBe(200);
    const list = await runCallerApiKeys(
        ["list", "--caller-id", "cli-caller"],
        f.keys,
    );
    expect(list).toEqual([
        expect.objectContaining({
            keyId: issued.metadata.keyId,
            status: "active",
        }),
    ]);
    expect(JSON.stringify(list)).not.toContain(issued.key);
    await runCallerApiKeys(
        ["revoke", "--key-id", issued.metadata.keyId],
        f.keys,
    );
    expect((await f.call("/execute", issued.key)).status).toBe(401);
});

it("keeps internal evaluation outside execute authentication even in required mode", async () => {
    const resolve = vi.fn(async () => {
        throw new Error("must not authenticate evaluation");
    });
    const result = {
        runId: "eval-run",
        process: "news-image-raw-humanism",
        version: "v1",
        status: "failed" as const,
        error: { code: "INVALID_INPUT" as const, message: "invalid" },
    };
    const logs: unknown[] = [];
    const app = createProcessingApplication({
        executor: {
            execute: async () => result,
            evaluate: async () => ({ result }),
        },
        http: {
            internalEvaluationEnabled: true,
            executeAuthMode: "required",
            callerIdentity: { resolve },
            logSink: (entry) => logs.push(entry),
        },
    });
    apps.push(app);
    const { url } = await app.listen();
    const response = await fetch(`${url}/internal/eval/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            process: "news-image-raw-humanism",
            version: "v1",
            input: {},
        }),
    });
    expect(response.status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toHaveProperty("authMethod");
    expect(logs[0]).not.toHaveProperty("callerId");
});

it("audits anonymous transport rejection and drops credential-shaped trace IDs", async () => {
    const logs: unknown[] = [];
    const app = createProcessingApplication({
        executor: {
            execute: async () => {
                throw new Error("not reached");
            },
        },
        http: {
            executeAuthMode: "audit",
            logSink: (record) => logs.push(record),
        },
    });
    apps.push(app);
    const { url } = await app.listen();
    const response = await fetch(`${url}/execute`, {
        method: "POST",
        headers: {
            "content-type": "text/plain",
            authorization: "Bearer ppk_do-not-log",
            "x-request-id": "ppk_do-not-log",
        },
        body: "private-business-input",
    });
    expect(response.status).toBe(415);
    expect(logs).toEqual(
        expect.arrayContaining([
            expect.objectContaining({
                event: "execute_anonymous",
                path: "/execute",
                authMethod: "anonymous",
            }),
        ]),
    );
    expect(JSON.stringify(logs)).not.toMatch(/ppk_|private-business/);
});

it("omits caller metadata when executeAuthMode is absent even with a valid key", async () => {
    const keys = createInMemoryCallerApiKeyStore();
    const issued = await keys.issue({ callerId: "caller", label: "test" });
    const resolve = vi.fn(
        createCompositeCallerIdentityResolver({ store: keys }).resolve,
    );
    const execute = vi.fn(async (_input: unknown, _caller?: unknown) => ({
        runId: "default-open",
        status: "succeeded" as const,
        process: "test",
        version: "v1",
        output: {},
    }));
    const logs: unknown[] = [];
    const app = createProcessingApplication({
        executor: { execute },
        http: {
            callerIdentity: { resolve },
            logSink: (entry) => logs.push(entry),
        },
    });
    apps.push(app);
    const { url } = await app.listen();
    expect(
        (
            await fetch(`${url}/execute`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${issued.key}`,
                },
                body: JSON.stringify(body),
            })
        ).status,
    ).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
    expect(execute.mock.calls[0][1]).toBeUndefined();
    expect(logs[0]).not.toHaveProperty("callerId");
    expect(logs[0]).not.toHaveProperty("authMethod");
});
