export const up = (pgm) => {
    pgm.sql(
        "ALTER TABLE process_run_records ADD COLUMN template_semantics_version integer CHECK (template_semantics_version > 0)",
    );
};

export const down = (pgm) => {
    pgm.sql(
        "ALTER TABLE process_run_records DROP COLUMN template_semantics_version",
    );
};
