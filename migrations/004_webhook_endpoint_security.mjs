export const up = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM webhook_endpoints LIMIT 1) THEN
        RAISE EXCEPTION
          '004_webhook_endpoint_security requires Webhook Endpoints to be reprovisioned after migration'
          USING ERRCODE = 'check_violation';
      END IF;
    END;
    $$;

    ALTER TABLE webhook_endpoints
      DROP CONSTRAINT webhook_endpoints_secret_check;
    ALTER TABLE webhook_endpoints
      RENAME COLUMN current_secret TO current_secret_envelope;
    ALTER TABLE webhook_endpoints
      RENAME COLUMN previous_secret TO previous_secret_envelope;
    ALTER TABLE webhook_endpoints
      ADD CONSTRAINT webhook_endpoints_secret_envelope_check CHECK (
        octet_length(current_secret_envelope) BETWEEN 80 AND 512
        AND current_secret_envelope LIKE 'enc.v1.%'
        AND (
          previous_secret_envelope IS NULL
          OR (
            octet_length(previous_secret_envelope) BETWEEN 80 AND 512
            AND previous_secret_envelope LIKE 'enc.v1.%'
          )
        )
      );

    CREATE TABLE webhook_endpoint_audit_events (
      audit_id uuid PRIMARY KEY,
      endpoint_id uuid NOT NULL,
      caller_id text NOT NULL,
      actor_id text NOT NULL,
      action text NOT NULL,
      reason_code text,
      created_at timestamptz NOT NULL,
      CONSTRAINT webhook_endpoint_audit_caller_check
        CHECK (octet_length(caller_id) BETWEEN 1 AND 512),
      CONSTRAINT webhook_endpoint_audit_actor_check
        CHECK (octet_length(actor_id) BETWEEN 1 AND 512),
      CONSTRAINT webhook_endpoint_audit_action_check CHECK (
        action IN (
          'provisioned',
          'registration_rejected',
          'url_updated',
          'url_update_rejected',
          'secret_rotated',
          'disabled',
          'delivery_target_rejected'
        )
      ),
      CONSTRAINT webhook_endpoint_audit_reason_check CHECK (
        reason_code IS NULL OR octet_length(reason_code) BETWEEN 1 AND 128
      )
    );

    CREATE INDEX webhook_endpoint_audit_owner_endpoint_idx
      ON webhook_endpoint_audit_events (
        caller_id,
        endpoint_id,
        created_at,
        audit_id
      );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM webhook_endpoints LIMIT 1) THEN
        RAISE EXCEPTION
          '004_webhook_endpoint_security rollback requires Webhook Endpoints to be reprovisioned'
          USING ERRCODE = 'check_violation';
      END IF;
    END;
    $$;

    DROP TABLE IF EXISTS webhook_endpoint_audit_events;
    ALTER TABLE webhook_endpoints
      DROP CONSTRAINT webhook_endpoints_secret_envelope_check;
    ALTER TABLE webhook_endpoints
      RENAME COLUMN current_secret_envelope TO current_secret;
    ALTER TABLE webhook_endpoints
      RENAME COLUMN previous_secret_envelope TO previous_secret;
    ALTER TABLE webhook_endpoints
      ADD CONSTRAINT webhook_endpoints_secret_check CHECK (
        octet_length(current_secret) BETWEEN 38 AND 96
        AND (
          previous_secret IS NULL
          OR octet_length(previous_secret) BETWEEN 38 AND 96
        )
      );
  `);
};
