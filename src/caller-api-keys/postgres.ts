/** 用 PostgreSQL 事务保存调用方密钥和审计，并以条件更新节流使用时间。 */
import type { Pool } from "pg";
import {
    createCallerApiKeyStore,
    type KeyAudit,
    type StoredKey,
} from "./index.js";
export function createPostgresCallerApiKeyStore(options: {
    pool: Pool;
    clock?: () => Date;
}) {
    const pool = options.pool;
    return createCallerApiKeyStore(
        {
            insert: async (key, audit) => {
                const client = await pool.connect();
                try {
                    await client.query("BEGIN");
                    await client.query(
                        `INSERT INTO caller_api_keys (key_id, caller_id, key_prefix, label, created_at, expires_at, key_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                        [
                            key.keyId,
                            key.callerId,
                            key.keyPrefix,
                            key.label,
                            key.createdAt,
                            key.expiresAt ?? null,
                            key.hash,
                        ],
                    );
                    await client.query(
                        "INSERT INTO caller_api_key_audits (entry) VALUES ($1)",
                        [JSON.stringify(audit)],
                    );
                    await client.query("COMMIT");
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                } finally {
                    client.release();
                }
            },
            find: async (hash) => {
                const { rows } = await pool.query(
                    "SELECT * FROM caller_api_keys WHERE key_hash=$1",
                    [hash],
                );
                return rows[0] ? decode(rows[0]) : undefined;
            },
            list: async (callerId) => {
                const { rows } = await pool.query(
                    "SELECT * FROM caller_api_keys WHERE ($1::text IS NULL OR caller_id=$1) ORDER BY created_at, key_id",
                    [callerId ?? null],
                );
                return rows.map(decode);
            },
            revoke: async (keyId, timestamp, audit) => {
                // 一条语句确保状态与审计共同提交，重复吊销不追加审计。
                const { rowCount } = await pool.query(
                    `WITH revoked AS (
                UPDATE caller_api_keys SET revoked_at=$2 WHERE key_id=$1 AND revoked_at IS NULL RETURNING *
            ) INSERT INTO caller_api_key_audits (entry)
            SELECT jsonb_build_object('operation','revoke','timestamp',$4::text,'callerId',caller_id,'keyId',key_id,'keyPrefix',key_prefix,'label',label) || $3::jsonb FROM revoked`,
                    [keyId, timestamp, JSON.stringify(audit), timestamp],
                );
                return rowCount === 1;
            },
            use: async (keyId, timestamp, before) => {
                await pool.query(
                    "UPDATE caller_api_keys SET last_used_at=$2 WHERE key_id=$1 AND (last_used_at IS NULL OR last_used_at <= $3)",
                    [keyId, timestamp, before],
                );
            },
            audits: async (callerId, limit) => {
                const order = limit === undefined ? "ASC" : "DESC";
                const { rows } = await pool.query(
                    `SELECT entry FROM caller_api_key_audits WHERE ($1::text IS NULL OR entry->>'callerId'=$1) ORDER BY id ${order} LIMIT $2`,
                    [callerId ?? null, limit ?? null],
                );
                return rows.map((row) => row.entry as KeyAudit);
            },
        },
        options.clock,
    );
}
function decode(row: Record<string, unknown>): StoredKey {
    return {
        keyId: row.key_id as string,
        callerId: row.caller_id as string,
        keyPrefix: row.key_prefix as string,
        label: row.label as string,
        hash: row.key_hash as string,
        createdAt: (row.created_at as Date).toISOString(),
        ...(row.expires_at
            ? { expiresAt: (row.expires_at as Date).toISOString() }
            : {}),
        ...(row.revoked_at
            ? { revokedAt: (row.revoked_at as Date).toISOString() }
            : {}),
        ...(row.last_used_at
            ? { lastUsedAt: (row.last_used_at as Date).toISOString() }
            : {}),
    };
}
