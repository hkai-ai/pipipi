export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE queue_recovery_runs (
      recovery_id uuid PRIMARY KEY,
      trigger_kind text NOT NULL,
      recovery_mode text NOT NULL,
      dry_run boolean NOT NULL,
      actor_id text NOT NULL,
      as_of timestamptz NOT NULL,
      queued_before timestamptz NOT NULL,
      cursor_run_id uuid,
      next_cursor_run_id uuid,
      status text NOT NULL DEFAULT 'running',
      candidate_count integer NOT NULL DEFAULT 0,
      missing_job_count integer NOT NULL DEFAULT 0,
      existing_job_count integer NOT NULL DEFAULT 0,
      terminal_job_count integer NOT NULL DEFAULT 0,
      invalid_job_count integer NOT NULL DEFAULT 0,
      active_lease_count integer NOT NULL DEFAULT 0,
      pending_outbox_count integer NOT NULL DEFAULT 0,
      enqueued_count integer NOT NULL DEFAULT 0,
      duplicate_count integer NOT NULL DEFAULT 0,
      outbox_acknowledged_count integer NOT NULL DEFAULT 0,
      failed_count integer NOT NULL DEFAULT 0,
      error_code text,
      started_at timestamptz NOT NULL,
      completed_at timestamptz,
      CONSTRAINT queue_recovery_trigger_check
        CHECK (trigger_kind IN ('periodic', 'manual')),
      CONSTRAINT queue_recovery_mode_check
        CHECK (recovery_mode IN ('stale', 'all')),
      CONSTRAINT queue_recovery_actor_check
        CHECK (octet_length(actor_id) BETWEEN 1 AND 512),
      CONSTRAINT queue_recovery_status_check
        CHECK (status IN ('running', 'completed', 'failed')),
      CONSTRAINT queue_recovery_counts_check CHECK (
        candidate_count >= 0
        AND missing_job_count >= 0
        AND existing_job_count >= 0
        AND terminal_job_count >= 0
        AND invalid_job_count >= 0
        AND active_lease_count >= 0
        AND pending_outbox_count >= 0
        AND enqueued_count >= 0
        AND duplicate_count >= 0
        AND outbox_acknowledged_count >= 0
        AND failed_count >= 0
      ),
      CONSTRAINT queue_recovery_completion_check CHECK (
        (
          status = 'running'
          AND completed_at IS NULL
          AND error_code IS NULL
        )
        OR (
          status = 'completed'
          AND completed_at IS NOT NULL
          AND error_code IS NULL
        )
        OR (
          status = 'failed'
          AND completed_at IS NOT NULL
          AND error_code IS NOT NULL
        )
      )
    );

    CREATE INDEX queue_recovery_runs_completed_idx
      ON queue_recovery_runs (completed_at, recovery_id);

    CREATE TABLE queue_recovery_items (
      recovery_id uuid NOT NULL
        REFERENCES queue_recovery_runs(recovery_id) ON DELETE CASCADE,
      run_id uuid NOT NULL,
      run_status text NOT NULL,
      reason text NOT NULL,
      pending_outbox boolean NOT NULL,
      queue_state text NOT NULL,
      action text NOT NULL,
      outbox_action text NOT NULL,
      recorded_at timestamptz NOT NULL,
      CONSTRAINT queue_recovery_items_pk PRIMARY KEY (recovery_id, run_id),
      CONSTRAINT queue_recovery_items_status_check
        CHECK (run_status IN ('queued', 'running')),
      CONSTRAINT queue_recovery_items_reason_check CHECK (
        reason IN (
          'recent_queued',
          'stuck_queued',
          'expired_lease',
          'active_lease'
        )
      ),
      CONSTRAINT queue_recovery_items_queue_state_check
        CHECK (queue_state IN ('missing', 'runnable', 'terminal', 'invalid')),
      CONSTRAINT queue_recovery_items_action_check CHECK (
        action IN (
          'none',
          'would_enqueue',
          'enqueued',
          'duplicate',
          'deferred',
          'failed'
        )
      ),
      CONSTRAINT queue_recovery_items_outbox_action_check CHECK (
        outbox_action IN (
          'none',
          'would_acknowledge',
          'acknowledged',
          'failed'
        )
      )
    );

    CREATE INDEX queue_recovery_items_run_idx
      ON queue_recovery_items (run_id, recorded_at, recovery_id);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS queue_recovery_items;
    DROP TABLE IF EXISTS queue_recovery_runs;
  `);
};
