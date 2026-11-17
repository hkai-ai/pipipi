export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE caller_api_keys (
            key_id text PRIMARY KEY,
            caller_id text NOT NULL,
            key_prefix text NOT NULL,
            label text NOT NULL,
            key_hash text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
            created_at timestamptz NOT NULL,
            expires_at timestamptz,
            revoked_at timestamptz,
            last_used_at timestamptz
        );
        CREATE INDEX caller_api_keys_caller ON caller_api_keys(caller_id);
        CREATE TABLE caller_api_key_audits (
            id bigserial PRIMARY KEY,
            entry jsonb NOT NULL CHECK (jsonb_typeof(entry) = 'object')
        );
        ALTER TABLE process_run_records ADD COLUMN caller_id text;
        ALTER TABLE process_run_records ADD COLUMN auth_method text CHECK (auth_method IN ('api_key','gateway','anonymous'));
    `);
};
export const down = (pgm) => {
    pgm.sql(`ALTER TABLE process_run_records DROP COLUMN auth_method, DROP COLUMN caller_id;
        DROP TABLE caller_api_key_audits;
        DROP TABLE caller_api_keys;`);
};
