/** 在内存中原子保存调用方密钥与审计，供无数据库开发和契约测试使用。 */
import {
    createCallerApiKeyStore,
    type KeyAudit,
    type StoredKey,
} from "./index.js";
export function createInMemoryCallerApiKeyStore(
    options: { clock?: () => Date } = {},
) {
    const keys = new Map<string, StoredKey>();
    const audits: KeyAudit[] = [];
    const idsByHash = new Map<string, string>();
    return createCallerApiKeyStore(
        {
            insert: async (key, audit) => {
                keys.set(key.keyId, structuredClone(key));
                idsByHash.set(key.hash, key.keyId);
                audits.push(structuredClone(audit));
            },
            find: async (hash) =>
                structuredClone(keys.get(idsByHash.get(hash) ?? "")),
            list: async (callerId) =>
                structuredClone(
                    [...keys.values()].filter(
                        (key) => !callerId || key.callerId === callerId,
                    ),
                ),
            revoke: async (keyId, timestamp, audit) => {
                const key = keys.get(keyId);
                if (!key || key.revokedAt) return false;
                keys.set(keyId, { ...key, revokedAt: timestamp });
                audits.push({
                    operation: "revoke",
                    timestamp,
                    callerId: key.callerId,
                    keyId,
                    keyPrefix: key.keyPrefix,
                    label: key.label,
                    ...audit,
                });
                return true;
            },
            use: async (keyId, timestamp, before) => {
                const key = keys.get(keyId);
                if (key && (!key.lastUsedAt || key.lastUsedAt <= before))
                    keys.set(keyId, { ...key, lastUsedAt: timestamp });
            },
            audits: async (callerId, limit) => {
                const matching = audits.filter(
                    (audit) => !callerId || audit.callerId === callerId,
                );
                return structuredClone(
                    limit === undefined
                        ? matching
                        : matching.reverse().slice(0, limit),
                );
            },
        },
        options.clock,
    );
}
