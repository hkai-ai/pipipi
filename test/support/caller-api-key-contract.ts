import { describe, expect, it } from "vitest";
import {
    type CallerApiKeyStore,
    hashCallerApiKey,
} from "../../src/caller-api-keys/index.js";
export function callerApiKeyContract(
    create: (clock: () => Date) => CallerApiKeyStore,
) {
    describe("Caller API Key store contract", () => {
        it("issues once, isolates callers, rotates and audits without secrets", async () => {
            const now = new Date("2026-11-17T00:00:00Z");
            const store = create(() => now);
            const old = await store.issue({
                callerId: "memebuy",
                label: "old",
                actor: "operator",
            });
            const next = await store.issue({
                callerId: "memebuy",
                label: "next",
            });
            await store.issue({ callerId: "other", label: "other" });
            expect(old.key).toMatch(/^ppk_/);
            expect(await store.findValid(old.key)).toEqual(old.metadata);
            expect(
                await store.findValidHash(hashCallerApiKey(old.key)),
            ).toEqual(old.metadata);
            expect(await store.findValid(`${old.key}x`)).toBeUndefined();
            expect(await store.list("memebuy")).toHaveLength(2);
            expect(
                await store.revoke(old.metadata.keyId, {
                    actor: "operator",
                    note: "rotated",
                }),
            ).toBe(true);
            expect(await store.revoke(old.metadata.keyId)).toBe(false);
            expect(await store.findValid(old.key)).toBeUndefined();
            expect(await store.findValid(next.key)).toMatchObject({
                callerId: "memebuy",
            });
            const audit = await store.audits("memebuy");
            expect(audit.map((entry) => entry.operation)).toEqual([
                "issue",
                "issue",
                "revoke",
            ]);
            expect(audit[2]).toMatchObject({
                actor: "operator",
                note: "rotated",
            });
            const serialized = JSON.stringify([await store.list(), audit]);
            expect(serialized).not.toContain(old.key);
            expect(serialized).not.toContain(hashCallerApiKey(old.key));
            expect(serialized).not.toContain(next.key);
        });
        it("normalizes caller identity and audit fields with identical optional keys", async () => {
            const now = new Date("2026-11-17T00:00:00Z");
            const store = create(() => now);
            const issued = await store.issue({
                callerId: "  memebuy-uat ",
                label: " UAT ",
                actor: " operator ",
                note: " issued ",
                expiresAt: "2026-11-18T00:00:00Z",
            });
            expect(issued.metadata).toMatchObject({
                callerId: "memebuy-uat",
                label: "UAT",
            });
            expect(await store.list(" memebuy-uat ")).toEqual([
                { ...issued.metadata, status: "active" },
            ]);
            const common = {
                timestamp: now.toISOString(),
                callerId: "memebuy-uat",
                keyId: issued.metadata.keyId,
                keyPrefix: issued.metadata.keyPrefix,
                label: "UAT",
            };
            expect(await store.audits(" memebuy-uat ")).toStrictEqual([
                {
                    ...common,
                    operation: "issue",
                    actor: "operator",
                    note: "issued",
                    expiresAt: "2026-11-18T00:00:00.000Z",
                },
            ]);
            expect(
                await store.revoke(` ${issued.metadata.keyId} `, {
                    actor: undefined,
                    note: undefined,
                }),
            ).toBe(true);
            expect(await store.audits("memebuy-uat")).toStrictEqual([
                {
                    ...common,
                    operation: "issue",
                    actor: "operator",
                    note: "issued",
                    expiresAt: "2026-11-18T00:00:00.000Z",
                },
                { ...common, operation: "revoke" },
            ]);
            const second = await store.issue({
                callerId: "memebuy-uat",
                label: "next",
                actor: " ",
                note: "\t",
            });
            await store.revoke(second.metadata.keyId, {
                actor: " replacement ",
                note: " rotated ",
            });
            const entries = await store.audits("memebuy-uat");
            expect(entries[2]).not.toHaveProperty("actor");
            expect(entries[2]).not.toHaveProperty("note");
            expect(entries[2]).not.toHaveProperty("expiresAt");
            expect(entries[3]).toMatchObject({
                actor: "replacement",
                note: "rotated",
            });
        });
        it("bounds recent audits after filtering and returns the newest entries first", async () => {
            const store = create(() => new Date("2026-11-17T00:00:00Z"));
            const first = await store.issue({
                callerId: "target",
                label: "first",
            });
            await store.issue({ callerId: "target", label: "second" });
            await store.revoke(first.metadata.keyId);
            await store.issue({ callerId: "other", label: "other" });
            const entries = await store.audits("target", 2);
            expect(
                entries.map(({ operation, label }) => [operation, label]),
            ).toEqual([
                ["revoke", "first"],
                ["issue", "second"],
            ]);
        });
        it("validates normalized UTF-8 metadata and rejects blank identity filters", async () => {
            const store = create(() => new Date("2026-11-17T00:00:00Z"));
            const boundary = `${"界".repeat(170)}ab`;
            const issued = await store.issue({
                callerId: ` ${boundary} `,
                label: ` ${boundary} `,
                actor: ` ${boundary} `,
                note: ` ${boundary} `,
            });
            expect(issued.metadata).toMatchObject({
                callerId: boundary,
                label: boundary,
            });
            for (const field of ["callerId", "label", "actor", "note"]) {
                await expect(
                    store.issue({
                        callerId: "valid",
                        label: "valid",
                        [field]: `${boundary}x`,
                    }),
                ).rejects.toThrow("512 bytes");
            }
            for (const field of ["callerId", "label"])
                await expect(
                    store.issue({
                        callerId: "valid",
                        label: "valid",
                        [field]: " ",
                    }),
                ).rejects.toThrow("nonempty");
            for (const value of [" ", `${boundary}x`]) {
                await expect(store.list(value)).rejects.toThrow();
                await expect(store.audits(value)).rejects.toThrow();
                await expect(store.revoke(value)).rejects.toThrow();
            }
            for (const field of ["actor", "note"])
                await expect(
                    store.revoke(issued.metadata.keyId, {
                        [field]: `${boundary}x`,
                    }),
                ).rejects.toThrow("512 bytes");
            expect(await store.findValid(issued.key)).toBeDefined();
        });
        it("expires at the boundary and throttles last use with the same clock", async () => {
            let now = new Date("2026-11-17T00:00:00Z");
            const store = create(() => now);
            const issued = await store.issue({
                callerId: "expiry",
                label: "temporary",
                expiresAt: "2026-11-17T00:02:00Z",
            });
            await store.recordUse(issued.metadata.keyId);
            now = new Date("2026-11-17T00:00:30Z");
            await store.recordUse(issued.metadata.keyId);
            expect((await store.list("expiry"))[0]).toMatchObject({
                lastUsedAt: "2026-11-17T00:00:00.000Z",
                status: "active",
            });
            now = new Date("2026-11-17T00:01:00Z");
            await store.recordUse(issued.metadata.keyId);
            expect((await store.list("expiry"))[0]).toMatchObject({
                lastUsedAt: now.toISOString(),
            });
            now = new Date("2026-11-17T00:02:00Z");
            expect(await store.findValid(issued.key)).toBeUndefined();
            expect((await store.list("expiry"))[0]).toMatchObject({
                status: "expired",
            });
        });
    });
}
