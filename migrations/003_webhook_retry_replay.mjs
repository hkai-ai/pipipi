export const up = (pgm) => {
    pgm.sql(`
    ALTER TABLE webhook_delivery_attempts
      DROP CONSTRAINT webhook_delivery_attempts_outcome_check,
      DROP CONSTRAINT webhook_delivery_attempts_latency_check,
      DROP CONSTRAINT webhook_delivery_attempts_time_check,
      ALTER COLUMN finished_at DROP NOT NULL,
      ALTER COLUMN latency_ms DROP NOT NULL,
      ADD CONSTRAINT webhook_delivery_attempts_outcome_check
        CHECK (outcome IN ('started', 'succeeded', 'failed')),
      ADD CONSTRAINT webhook_delivery_attempts_completion_check CHECK (
        (outcome = 'started') =
          (finished_at IS NULL AND latency_ms IS NULL)
      ),
      ADD CONSTRAINT webhook_delivery_attempts_latency_check
        CHECK (latency_ms IS NULL OR latency_ms >= 0),
      ADD CONSTRAINT webhook_delivery_attempts_time_check
        CHECK (finished_at IS NULL OR finished_at >= started_at);

    ALTER TABLE webhook_deliveries
      DROP CONSTRAINT webhook_deliveries_event_endpoint_unique;
    ALTER TABLE webhook_deliveries
      ADD COLUMN replay_number integer NOT NULL DEFAULT 0,
      ADD COLUMN replay_of_delivery_id uuid
        REFERENCES webhook_deliveries(delivery_id) ON DELETE SET NULL,
      ADD CONSTRAINT webhook_deliveries_replay_number_check
        CHECK (replay_number >= 0),
      ADD CONSTRAINT webhook_deliveries_event_endpoint_replay_unique
        UNIQUE (event_id, endpoint_id, replay_number);

    CREATE TABLE webhook_delivery_replays (
      replay_id uuid PRIMARY KEY,
      source_delivery_id uuid NOT NULL
        REFERENCES webhook_deliveries(delivery_id) ON DELETE CASCADE,
      replay_delivery_id uuid NOT NULL UNIQUE
        REFERENCES webhook_deliveries(delivery_id) ON DELETE CASCADE,
      caller_id text NOT NULL,
      actor_id text NOT NULL,
      created_at timestamptz NOT NULL,
      CONSTRAINT webhook_delivery_replays_caller_check
        CHECK (octet_length(caller_id) BETWEEN 1 AND 512),
      CONSTRAINT webhook_delivery_replays_actor_check
        CHECK (octet_length(actor_id) BETWEEN 1 AND 512),
      CONSTRAINT webhook_delivery_replays_distinct_check
        CHECK (source_delivery_id <> replay_delivery_id)
    );

    CREATE INDEX webhook_delivery_replays_source_idx
      ON webhook_delivery_replays (source_delivery_id, created_at, replay_id);
  `);
};

export const down = (pgm) => {
    pgm.sql(`
    DELETE FROM outbox_messages
    WHERE topic = 'webhook-deliveries'
      AND payload->>'deliveryId' IN (
        SELECT replay_delivery_id::text FROM webhook_delivery_replays
      );
    DROP TABLE IF EXISTS webhook_delivery_replays;
    DELETE FROM webhook_deliveries WHERE replay_number > 0;
    ALTER TABLE webhook_deliveries
      DROP CONSTRAINT webhook_deliveries_event_endpoint_replay_unique,
      DROP CONSTRAINT webhook_deliveries_replay_number_check,
      DROP COLUMN replay_of_delivery_id,
      DROP COLUMN replay_number,
      ADD CONSTRAINT webhook_deliveries_event_endpoint_unique
        UNIQUE (event_id, endpoint_id);
    DELETE FROM webhook_delivery_attempts WHERE outcome = 'started';
    ALTER TABLE webhook_delivery_attempts
      DROP CONSTRAINT webhook_delivery_attempts_outcome_check,
      DROP CONSTRAINT webhook_delivery_attempts_completion_check,
      DROP CONSTRAINT webhook_delivery_attempts_latency_check,
      DROP CONSTRAINT webhook_delivery_attempts_time_check,
      ALTER COLUMN finished_at SET NOT NULL,
      ALTER COLUMN latency_ms SET NOT NULL,
      ADD CONSTRAINT webhook_delivery_attempts_outcome_check
        CHECK (outcome IN ('succeeded', 'failed')),
      ADD CONSTRAINT webhook_delivery_attempts_latency_check
        CHECK (latency_ms >= 0),
      ADD CONSTRAINT webhook_delivery_attempts_time_check
        CHECK (finished_at >= started_at);
  `);
};
