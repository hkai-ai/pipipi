export const up = (pgm) => {
    pgm.sql(`
    ALTER TABLE outbox_messages
      DROP CONSTRAINT IF EXISTS outbox_messages_event_id_key;

    CREATE TABLE webhook_endpoints (
      endpoint_id uuid PRIMARY KEY,
      caller_id text NOT NULL,
      url text NOT NULL,
      current_secret text NOT NULL,
      previous_secret text,
      previous_secret_valid_until timestamptz,
      status text NOT NULL DEFAULT 'enabled',
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      disabled_at timestamptz,
      CONSTRAINT webhook_endpoints_caller_check
        CHECK (octet_length(caller_id) BETWEEN 1 AND 512),
      CONSTRAINT webhook_endpoints_url_check
        CHECK (octet_length(url) BETWEEN 1 AND 4096),
      CONSTRAINT webhook_endpoints_secret_check CHECK (
        octet_length(current_secret) BETWEEN 38 AND 96
        AND (
          previous_secret IS NULL
          OR octet_length(previous_secret) BETWEEN 38 AND 96
        )
      ),
      CONSTRAINT webhook_endpoints_status_check
        CHECK (status IN ('enabled', 'disabled')),
      CONSTRAINT webhook_endpoints_disabled_check CHECK (
        (status = 'disabled') = (disabled_at IS NOT NULL)
      ),
      CONSTRAINT webhook_endpoints_previous_secret_check CHECK (
        (previous_secret IS NULL) = (previous_secret_valid_until IS NULL)
      ),
      CONSTRAINT webhook_endpoints_owner_url_unique UNIQUE (caller_id, url)
    );

    CREATE INDEX webhook_endpoints_owner_status_idx
      ON webhook_endpoints (caller_id, status, endpoint_id);

    CREATE TABLE webhook_deliveries (
      delivery_id uuid PRIMARY KEY,
      event_id uuid NOT NULL
        REFERENCES process_events(event_id) ON DELETE CASCADE,
      endpoint_id uuid NOT NULL
        REFERENCES webhook_endpoints(endpoint_id) ON DELETE CASCADE,
      run_id uuid NOT NULL
        REFERENCES process_runs(run_id) ON DELETE CASCADE,
      caller_id text NOT NULL,
      event_type text NOT NULL,
      payload text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      attempt_count integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL,
      claim_token uuid,
      claim_expires_at timestamptz,
      last_http_status integer,
      last_error_code text,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      completed_at timestamptz,
      CONSTRAINT webhook_deliveries_owner_check
        CHECK (octet_length(caller_id) BETWEEN 1 AND 512),
      CONSTRAINT webhook_deliveries_event_type_check CHECK (
        event_type IN ('process_run.succeeded', 'process_run.failed')
      ),
      CONSTRAINT webhook_deliveries_payload_check
        CHECK (octet_length(payload) BETWEEN 2 AND 20480),
      CONSTRAINT webhook_deliveries_status_check CHECK (
        status IN ('pending', 'delivering', 'succeeded', 'failed', 'exhausted')
      ),
      CONSTRAINT webhook_deliveries_attempt_count_check
        CHECK (attempt_count >= 0),
      CONSTRAINT webhook_deliveries_http_status_check CHECK (
        last_http_status IS NULL
        OR last_http_status BETWEEN 100 AND 599
      ),
      CONSTRAINT webhook_deliveries_claim_check CHECK (
        (status = 'delivering') =
          (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
      ),
      CONSTRAINT webhook_deliveries_completed_check CHECK (
        (status IN ('succeeded', 'failed', 'exhausted')) =
          (completed_at IS NOT NULL)
      ),
      CONSTRAINT webhook_deliveries_event_endpoint_unique
        UNIQUE (event_id, endpoint_id)
    );

    CREATE INDEX webhook_deliveries_pending_idx
      ON webhook_deliveries (next_attempt_at, created_at, delivery_id)
      WHERE status = 'pending';
    CREATE INDEX webhook_deliveries_owner_run_idx
      ON webhook_deliveries (caller_id, run_id, created_at, delivery_id);
    CREATE INDEX webhook_deliveries_claim_expiry_idx
      ON webhook_deliveries (claim_expires_at, delivery_id)
      WHERE status = 'delivering';

    CREATE TABLE webhook_delivery_attempts (
      delivery_id uuid NOT NULL
        REFERENCES webhook_deliveries(delivery_id) ON DELETE CASCADE,
      attempt_number integer NOT NULL,
      started_at timestamptz NOT NULL,
      finished_at timestamptz NOT NULL,
      outcome text NOT NULL,
      http_status integer,
      latency_ms integer NOT NULL,
      error_code text,
      next_attempt_at timestamptz,
      CONSTRAINT webhook_delivery_attempts_pk
        PRIMARY KEY (delivery_id, attempt_number),
      CONSTRAINT webhook_delivery_attempts_number_check
        CHECK (attempt_number > 0),
      CONSTRAINT webhook_delivery_attempts_outcome_check
        CHECK (outcome IN ('succeeded', 'failed')),
      CONSTRAINT webhook_delivery_attempts_http_status_check CHECK (
        http_status IS NULL OR http_status BETWEEN 100 AND 599
      ),
      CONSTRAINT webhook_delivery_attempts_latency_check
        CHECK (latency_ms >= 0),
      CONSTRAINT webhook_delivery_attempts_time_check
        CHECK (finished_at >= started_at)
    );

    CREATE INDEX webhook_delivery_attempts_result_idx
      ON webhook_delivery_attempts (outcome, finished_at, delivery_id);
  `);
};

export const down = (pgm) => {
    pgm.sql(`
    DROP TABLE IF EXISTS webhook_delivery_attempts;
    DROP TABLE IF EXISTS webhook_deliveries;
    DROP TABLE IF EXISTS webhook_endpoints;
    DELETE FROM outbox_messages WHERE topic = 'webhook-deliveries';
    ALTER TABLE outbox_messages
      ADD CONSTRAINT outbox_messages_event_id_key UNIQUE (event_id);
  `);
};
