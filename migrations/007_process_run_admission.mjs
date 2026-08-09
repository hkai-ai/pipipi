export const up = (pgm) => {
  pgm.sql(`
    CREATE INDEX process_runs_caller_backlog_idx
      ON process_runs (caller_id, status, updated_at, run_id)
      WHERE status IN ('queued', 'running');
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS process_runs_caller_backlog_idx;
  `);
};
