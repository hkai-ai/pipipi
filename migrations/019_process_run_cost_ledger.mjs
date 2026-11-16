export const up = (pgm) => {
    // 各次 Attempt 账本快照的累计 {usd, provider, estimate, unknown}；NULL 表示没有记录。
    pgm.sql(
        "ALTER TABLE process_runs ADD COLUMN cost_ledger jsonb CHECK (cost_ledger IS NULL OR jsonb_typeof(cost_ledger) = 'object')",
    );
};

export const down = (pgm) => {
    pgm.sql("ALTER TABLE process_runs DROP COLUMN cost_ledger");
};
