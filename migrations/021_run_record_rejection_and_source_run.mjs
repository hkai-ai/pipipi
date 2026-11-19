export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE process_run_records ADD COLUMN source_run_id text;
        ALTER TABLE process_run_records ADD COLUMN failure_detail jsonb
            CHECK (
                failure_detail IS NULL
                OR (
                    jsonb_typeof(failure_detail) = 'object'
                    AND octet_length(failure_detail::text) <= 16384
                )
            );
    `);
};

export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE process_run_records
            DROP COLUMN IF EXISTS failure_detail,
            DROP COLUMN IF EXISTS source_run_id;
    `);
};
