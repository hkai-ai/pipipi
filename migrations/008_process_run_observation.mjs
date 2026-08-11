export const up = (pgm) => {
    pgm.sql(`
    CREATE TABLE process_run_records (
      schema_version smallint NOT NULL DEFAULT 1,
      run_id text PRIMARY KEY,
      recorded_at timestamptz NOT NULL,
      process_id text,
      process_version text,
      status text NOT NULL,
      error_code text,
      content jsonb,
      CONSTRAINT process_run_records_schema_version_check
        CHECK (schema_version = 1),
      CONSTRAINT process_run_records_run_id_check
        CHECK (octet_length(run_id) BETWEEN 1 AND 256),
      CONSTRAINT process_run_records_status_check
        CHECK (status IN ('succeeded', 'failed')),
      CONSTRAINT process_run_records_error_code_check
        CHECK (
          (status = 'failed' AND error_code IS NOT NULL)
          OR (status = 'succeeded' AND error_code IS NULL)
        ),
      CONSTRAINT process_run_records_content_size_check
        CHECK (
          content IS NULL
          OR octet_length(content::text) <= 1048576
        )
    );

    CREATE INDEX process_run_records_recorded_idx
      ON process_run_records (recorded_at DESC, run_id DESC);

    CREATE TABLE process_run_activities (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      schema_version smallint NOT NULL DEFAULT 1,
      run_id text NOT NULL,
      recorded_at timestamptz NOT NULL,
      process_id text NOT NULL,
      process_version text NOT NULL,
      attempt_number integer NOT NULL,
      sequence integer NOT NULL,
      event text NOT NULL,
      activity text,
      outcome text,
      duration_ms integer,
      error_code text,
      CONSTRAINT process_run_activities_schema_version_check
        CHECK (schema_version = 1),
      CONSTRAINT process_run_activities_run_id_check
        CHECK (octet_length(run_id) BETWEEN 1 AND 256),
      CONSTRAINT process_run_activities_ordering_check
        CHECK (attempt_number >= 1 AND sequence >= 1),
      CONSTRAINT process_run_activities_duration_check
        CHECK (duration_ms IS NULL OR duration_ms >= 0)
    );

    CREATE INDEX process_run_activities_run_idx
      ON process_run_activities (run_id, attempt_number, sequence, id);
    CREATE INDEX process_run_activities_recorded_idx
      ON process_run_activities (recorded_at);
  `);
};

export const down = (pgm) => {
    pgm.sql(`
    DROP TABLE IF EXISTS process_run_activities;
    DROP TABLE IF EXISTS process_run_records;
  `);
};
