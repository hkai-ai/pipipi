/** 管理调用方密钥的发放、有效性、审计和节流使用记录，统一内存与数据库行为。 */
import {
    createHash,
    randomBytes,
    randomUUID,
    timingSafeEqual,
} from "node:crypto";

export const callerApiKeyPrefix = "ppk_";
export type CallerApiKey = Readonly<{
    keyId: string;
    callerId: string;
    keyPrefix: string;
    label: string;
    createdAt: string;
    expiresAt?: string;
    revokedAt?: string;
    lastUsedAt?: string;
}>;
export type KeyAudit = Readonly<{
    operation: "issue" | "revoke";
    expiresAt?: string;
    timestamp: string;
    callerId: string;
    keyId: string;
    keyPrefix: string;
    label: string;
    actor?: string;
    note?: string;
}>;
export type IssueKey = Readonly<{
    callerId: string;
    label: string;
    expiresAt?: string;
    actor?: string;
    note?: string;
}>;
export class InvalidKeyInput extends Error {}

export type CallerApiKeyStore = Readonly<{
    issue: (
        input: IssueKey,
    ) => Promise<{ key: string; metadata: CallerApiKey }>;
    findValid: (key: string) => Promise<CallerApiKey | undefined>;
    findValidHash: (hash: string) => Promise<CallerApiKey | undefined>;
    list: (
        callerId?: string,
    ) => Promise<
        readonly (CallerApiKey & { status: "active" | "revoked" | "expired" })[]
    >;
    revoke: (
        keyId: string,
        audit?: { actor?: string; note?: string },
    ) => Promise<boolean>;
    recordUse: (keyId: string) => Promise<void>;
    /** With a limit, return the most recent entries first. */
    audits: (callerId?: string, limit?: number) => Promise<readonly KeyAudit[]>;
}>;
export type StoredKey = CallerApiKey & Readonly<{ hash: string }>;
export type KeyRepository = Readonly<{
    insert: (key: StoredKey, audit: KeyAudit) => Promise<void>;
    find: (hash: string) => Promise<StoredKey | undefined>;
    list: (callerId?: string) => Promise<readonly StoredKey[]>;
    revoke: (
        keyId: string,
        timestamp: string,
        audit: { actor?: string; note?: string },
    ) => Promise<boolean>;
    use: (keyId: string, timestamp: string, before: string) => Promise<void>;
    /** With a limit, return the most recent entries first. */
    audits: (callerId?: string, limit?: number) => Promise<readonly KeyAudit[]>;
}>;
export function hashCallerApiKey(key: string): string {
    return createHash("sha256").update(key).digest("hex");
}
function metadata({ hash: _hash, ...key }: StoredKey): CallerApiKey {
    return key;
}
export function createCallerApiKeyStore(
    repository: KeyRepository,
    clock: () => Date = () => new Date(),
): CallerApiKeyStore {
    const uses = new Map<string, number>();
    const windowMs = 60_000;
    const store: CallerApiKeyStore = {
        issue: async (input) => {
            const callerId = normalizeText(input.callerId);
            const label = normalizeText(input.label);
            const audit = normalizeAudit(input);
            const now = clock();
            if (
                input.expiresAt !== undefined &&
                (!Number.isFinite(Date.parse(input.expiresAt)) ||
                    Date.parse(input.expiresAt) <= now.getTime())
            )
                throw new InvalidKeyInput("Expiry must be a future timestamp");
            const keyId = randomUUID();
            const keyPrefix = `${callerApiKeyPrefix}${keyId.slice(0, 8)}`;
            const key = `${keyPrefix}_${randomBytes(32).toString("base64url")}`;
            const record: StoredKey = {
                keyId,
                callerId,
                keyPrefix,
                label,
                createdAt: now.toISOString(),
                ...(input.expiresAt
                    ? { expiresAt: new Date(input.expiresAt).toISOString() }
                    : {}),
                hash: hashCallerApiKey(key),
            };
            await repository.insert(record, {
                operation: "issue",
                timestamp: record.createdAt,
                callerId: record.callerId,
                keyId,
                keyPrefix,
                label: record.label,
                ...audit,
                ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
            });
            return { key, metadata: metadata(record) };
        },
        findValid: (key) => store.findValidHash(hashCallerApiKey(key)),
        findValidHash: async (hash) => {
            if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
            const record = await repository.find(hash);
            if (
                !record ||
                !timingSafeEqual(
                    Buffer.from(hash, "hex"),
                    Buffer.from(record.hash, "hex"),
                ) ||
                record.revokedAt ||
                (record.expiresAt &&
                    Date.parse(record.expiresAt) <= clock().getTime())
            )
                return undefined;
            return metadata(record);
        },
        list: async (callerId) =>
            (
                await repository.list(
                    callerId === undefined
                        ? undefined
                        : normalizeText(callerId),
                )
            ).map((record) => ({
                ...metadata(record),
                status: record.revokedAt
                    ? "revoked"
                    : record.expiresAt &&
                        Date.parse(record.expiresAt) <= clock().getTime()
                      ? "expired"
                      : "active",
            })),
        revoke: async (keyId, audit = {}) =>
            repository.revoke(
                normalizeText(keyId),
                clock().toISOString(),
                normalizeAudit(audit),
            ),
        recordUse: async (keyId) => {
            const now = clock();
            if (now.getTime() - (uses.get(keyId) ?? -Infinity) < windowMs)
                return;
            if (uses.size >= 10_000)
                uses.delete(uses.keys().next().value as string);
            uses.set(keyId, now.getTime());
            try {
                await repository.use(
                    keyId,
                    now.toISOString(),
                    new Date(now.getTime() - windowMs).toISOString(),
                );
            } catch {
                /* 使用观测失败不改变认证结果。 */
            }
        },
        audits: async (callerId, limit) =>
            repository.audits(
                callerId === undefined ? undefined : normalizeText(callerId),
                limit,
            ),
    };
    return store;
}

function normalizeText(value: string): string {
    const normalized = value.trim();
    if (!normalized || Buffer.byteLength(normalized, "utf8") > 512)
        throw new InvalidKeyInput(
            "Key metadata must be nonempty and at most 512 bytes",
        );
    return normalized;
}

function normalizeAudit(input: { actor?: string; note?: string }) {
    const actor = input.actor?.trim() ? normalizeText(input.actor) : undefined;
    const note = input.note?.trim() ? normalizeText(input.note) : undefined;
    return {
        ...(actor === undefined ? {} : { actor }),
        ...(note === undefined ? {} : { note }),
    };
}
