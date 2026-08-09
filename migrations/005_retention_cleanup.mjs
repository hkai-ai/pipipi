export const up = (pgm) => {
    pgm.sql(`
    ALTER TABLE process_runs
      DROP CONSTRAINT process_runs_accepted_input_size_check,
      DROP CONSTRAINT process_runs_result_check,
      ALTER COLUMN accepted_input DROP NOT NULL,
      ADD COLUMN input_expired_at timestamptz,
      ADD COLUMN result_expired_at timestamptz,
      ADD CONSTRAINT process_runs_accepted_input_size_check CHECK (
        accepted_input IS NULL
        OR octet_length(accepted_input::text) <= 270336
      ),
      ADD CONSTRAINT process_runs_input_content_check CHECK (
        (
          status IN ('queued', 'running')
          AND accepted_input IS NOT NULL
          AND input_expired_at IS NULL
        )
        OR (
          status IN ('succeeded', 'failed')
          AND (
            (accepted_input IS NOT NULL AND input_expired_at IS NULL)
            OR (accepted_input IS NULL AND input_expired_at IS NOT NULL)
          )
        )
      ),
      ADD CONSTRAINT process_runs_result_check CHECK (
        (
          status = 'succeeded'
          AND error_code IS NULL
          AND public_error_message IS NULL
          AND (
            (output IS NOT NULL AND result_expired_at IS NULL)
            OR (output IS NULL AND result_expired_at IS NOT NULL)
          )
        )
        OR (
          status = 'failed'
          AND output IS NULL
          AND (
            (
              error_code IS NOT NULL
              AND public_error_message IS NOT NULL
              AND result_expired_at IS NULL
            )
            OR (
              error_code IS NULL
              AND public_error_message IS NULL
              AND result_expired_at IS NOT NULL
            )
          )
        )
        OR (
          status IN ('queued', 'running')
          AND output IS NULL
          AND error_code IS NULL
          AND public_error_message IS NULL
          AND result_expired_at IS NULL
        )
      ),
      ADD CONSTRAINT process_runs_content_expiry_time_check CHECK (
        (input_expired_at IS NULL OR input_expired_at >= created_at)
        AND (
          result_expired_at IS NULL
          OR (
            finished_at IS NOT NULL
            AND result_expired_at >= finished_at
          )
        )
      );

    CREATE INDEX process_runs_input_expiry_idx
      ON process_runs (input_expires_at, run_id)
      WHERE accepted_input IS NOT NULL
        AND status IN ('succeeded', 'failed');
    CREATE INDEX process_runs_result_expiry_idx
      ON process_runs (result_expires_at, run_id)
      WHERE status IN ('succeeded', 'failed')
        AND result_expired_at IS NULL;
    CREATE INDEX process_runs_metadata_expiry_idx
      ON process_runs (metadata_expires_at, run_id)
      WHERE status IN ('succeeded', 'failed');

    CREATE TABLE retention_cleanup_batches (
      cleanup_id uuid PRIMARY KEY,
      as_of timestamptz NOT NULL,
      cursor_run_id uuid,
      next_cursor_run_id uuid,
      examined_count integer NOT NULL,
      input_deleted_count integer NOT NULL,
      result_deleted_count integer NOT NULL,
      delivery_attempt_deleted_count integer NOT NULL,
      run_deleted_count integer NOT NULL,
      deferred_run_count integer NOT NULL,
      completed_at timestamptz NOT NULL,
      CONSTRAINT retention_cleanup_counts_check CHECK (
        examined_count >= 0
        AND input_deleted_count >= 0
        AND result_deleted_count >= 0
        AND delivery_attempt_deleted_count >= 0
        AND run_deleted_count >= 0
        AND deferred_run_count >= 0
      )
    );

    CREATE INDEX retention_cleanup_batches_completed_idx
      ON retention_cleanup_batches (completed_at, cleanup_id);
  `);
};

export const down = (pgm) => {
    pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM process_runs
        WHERE input_expired_at IS NOT NULL OR result_expired_at IS NOT NULL
      ) THEN
        RAISE EXCEPTION
          '005_retention_cleanup rollback requires no expired Process Run content'
          USING ERRCODE = 'check_violation';
      END IF;
    END;
    $$;

    DROP TABLE IF EXISTS retention_cleanup_batches;
    DROP INDEX IF EXISTS process_runs_metadata_expiry_idx;
    DROP INDEX IF EXISTS process_runs_result_expiry_idx;
    DROP INDEX IF EXISTS process_runs_input_expiry_idx;
    ALTER TABLE process_runs
      DROP CONSTRAINT process_runs_content_expiry_time_check,
      DROP CONSTRAINT process_runs_result_check,
      DROP CONSTRAINT process_runs_input_content_check,
      DROP CONSTRAINT process_runs_accepted_input_size_check,
      DROP COLUMN result_expired_at,
      DROP COLUMN input_expired_at,
      ALTER COLUMN accepted_input SET NOT NULL,
      ADD CONSTRAINT process_runs_accepted_input_size_check
        CHECK (octet_length(accepted_input::text) <= 270336),
      ADD CONSTRAINT process_runs_result_check CHECK (
        (
          status = 'succeeded'
          AND output IS NOT NULL
          AND error_code IS NULL
          AND public_error_message IS NULL
        )
        OR (
          status = 'failed'
          AND output IS NULL
          AND error_code IS NOT NULL
          AND public_error_message IS NOT NULL
        )
        OR (
          status IN ('queued', 'running')
          AND output IS NULL
          AND error_code IS NULL
          AND public_error_message IS NULL
        )
      );
  `);
};
