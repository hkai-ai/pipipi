export const up = (pgm) => {
    pgm.sql(`ALTER TABLE process_run_activities ADD COLUMN diagnostic jsonb
        CHECK (diagnostic IS NULL OR octet_length(diagnostic::text) <= 4096)`);
};

export const down = (pgm) => {
    pgm.sql("ALTER TABLE process_run_activities DROP COLUMN diagnostic");
};
