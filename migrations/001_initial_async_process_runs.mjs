export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE process_runs (
      schema_version smallint NOT NULL DEFAULT 1,
      run_id uuid PRIMARY KEY,
      caller_id text NOT NULL,
      idempotency_key text NOT NULL,
      request_fingerprint text NOT NULL,
      process_id text NOT NULL,
      process_version text NOT NULL,
      status text NOT NULL,
      accepted_input jsonb NOT NULL,
      output jsonb,
      error_code text,
      public_error_message text,
      attempt_count integer NOT NULL DEFAULT 0,
      revision bigint NOT NULL DEFAULT 0,
      claim_token uuid,
      claim_expires_at timestamptz,
      created_at timestamptz NOT NULL,
      started_at timestamptz,
      finished_at timestamptz,
      updated_at timestamptz NOT NULL,
      input_expires_at timestamptz,
      result_expires_at timestamptz,
      metadata_expires_at timestamptz,
      CONSTRAINT process_runs_schema_version_check
        CHECK (schema_version = 1),
      CONSTRAINT process_runs_caller_id_check
        CHECK (octet_length(caller_id) BETWEEN 1 AND 512),
      CONSTRAINT process_runs_idempotency_key_check
        CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
      CONSTRAINT process_runs_request_fingerprint_check
        CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT process_runs_process_identity_check
        CHECK (
          octet_length(process_id) BETWEEN 1 AND 4096
          AND octet_length(process_version) BETWEEN 1 AND 4096
        ),
      CONSTRAINT process_runs_status_check
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
      CONSTRAINT process_runs_accepted_input_size_check
        CHECK (octet_length(accepted_input::text) <= 270336),
      CONSTRAINT process_runs_attempt_count_check CHECK (attempt_count >= 0),
      CONSTRAINT process_runs_revision_check CHECK (revision >= 0),
      CONSTRAINT process_runs_claim_check CHECK (
        (status = 'running') =
          (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
      ),
      CONSTRAINT process_runs_finished_check CHECK (
        (status IN ('succeeded', 'failed')) = (finished_at IS NOT NULL)
      ),
      CONSTRAINT process_runs_started_check CHECK (
        status = 'queued' OR started_at IS NOT NULL
      ),
      CONSTRAINT process_runs_error_code_check CHECK (
        error_code IS NULL OR error_code IN (
          'AGENT_FAILURE',
          'DEPENDENCY_FAILURE',
          'INTERNAL_ERROR',
          'INVALID_INPUT',
          'INVALID_OUTPUT',
          'PROCESS_NOT_FOUND',
          'PROCESS_TIMEOUT'
        )
      ),
      CONSTRAINT process_runs_result_check CHECK (
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
      ),
      CONSTRAINT process_runs_time_order_check CHECK (
        updated_at >= created_at
        AND (started_at IS NULL OR started_at >= created_at)
        AND (finished_at IS NULL OR finished_at >= created_at)
      ),
      CONSTRAINT process_runs_owner_idempotency_unique
        UNIQUE (caller_id, idempotency_key)
    );

    CREATE INDEX process_runs_status_updated_idx
      ON process_runs (status, updated_at, run_id);
    CREATE INDEX process_runs_claim_expiry_idx
      ON process_runs (claim_expires_at, run_id)
      WHERE status = 'running';

    CREATE TABLE process_run_attempts (
      run_id uuid NOT NULL REFERENCES process_runs(run_id) ON DELETE CASCADE,
      attempt_number integer NOT NULL,
      claim_token uuid NOT NULL,
      status text NOT NULL,
      started_at timestamptz NOT NULL,
      finished_at timestamptz,
      result_code text,
      CONSTRAINT process_run_attempts_pk
        PRIMARY KEY (run_id, attempt_number),
      CONSTRAINT process_run_attempts_claim_unique UNIQUE (claim_token),
      CONSTRAINT process_run_attempts_number_check CHECK (attempt_number > 0),
      CONSTRAINT process_run_attempts_status_check
        CHECK (status IN ('running', 'succeeded', 'failed', 'abandoned')),
      CONSTRAINT process_run_attempts_finished_check CHECK (
        (status = 'running') = (finished_at IS NULL)
      )
    );

    CREATE INDEX process_run_attempts_status_idx
      ON process_run_attempts (status, started_at, run_id);

    CREATE TABLE process_events (
      event_id uuid PRIMARY KEY,
      run_id uuid NOT NULL REFERENCES process_runs(run_id) ON DELETE CASCADE,
      event_type text NOT NULL,
      deduplication_key text NOT NULL UNIQUE,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      CONSTRAINT process_events_type_check CHECK (
        event_type IN (
          'process_run.queued',
          'process_run.succeeded',
          'process_run.failed'
        )
      )
    );

    CREATE INDEX process_events_run_created_idx
      ON process_events (run_id, created_at, event_id);

    CREATE TABLE outbox_messages (
      message_id uuid PRIMARY KEY,
      event_id uuid NOT NULL UNIQUE
        REFERENCES process_events(event_id) ON DELETE CASCADE,
      topic text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      available_at timestamptz NOT NULL,
      claim_token uuid,
      claim_expires_at timestamptz,
      published_at timestamptz,
      publish_attempt_count integer NOT NULL DEFAULT 0,
      CONSTRAINT outbox_messages_topic_check
        CHECK (topic IN ('process-runs', 'webhook-deliveries')),
      CONSTRAINT outbox_messages_attempt_count_check
        CHECK (publish_attempt_count >= 0),
      CONSTRAINT outbox_messages_claim_check CHECK (
        (claim_token IS NULL) = (claim_expires_at IS NULL)
      )
    );

    CREATE INDEX outbox_messages_pending_idx
      ON outbox_messages (available_at, created_at, message_id)
      WHERE published_at IS NULL;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS outbox_messages;
    DROP TABLE IF EXISTS process_events;
    DROP TABLE IF EXISTS process_run_attempts;
    DROP TABLE IF EXISTS process_runs;
  `);
};
