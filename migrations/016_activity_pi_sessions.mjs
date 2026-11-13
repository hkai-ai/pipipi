export const up = (pgm) => {
    pgm.sql(`ALTER TABLE process_run_activities
        ADD COLUMN activity_id integer CHECK (activity_id > 0),
        ADD COLUMN pi_sessions jsonb CHECK (jsonb_typeof(pi_sessions) = 'array')`);
};

export const down = (pgm) => {
    pgm.sql(
        "ALTER TABLE process_run_activities DROP COLUMN pi_sessions, DROP COLUMN activity_id",
    );
};
