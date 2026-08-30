export const up = (pgm) => {
    pgm.sql(`
    CREATE TABLE agent_conversations (
      schema_version smallint NOT NULL DEFAULT 1,
      conversation_id text PRIMARY KEY,
      owner_id text NOT NULL,
      agent_id text NOT NULL,
      agent_version text NOT NULL,
      config_revision text NOT NULL,
      status text NOT NULL DEFAULT 'busy',
      working_summary text,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      CONSTRAINT agent_conversations_schema_version_check
        CHECK (schema_version = 1),
      CONSTRAINT agent_conversations_identity_check
        CHECK (octet_length(conversation_id) BETWEEN 1 AND 256),
      CONSTRAINT agent_conversations_owner_check
        CHECK (octet_length(owner_id) BETWEEN 1 AND 512),
      CONSTRAINT agent_conversations_agent_check
        CHECK (
          octet_length(agent_id) BETWEEN 1 AND 4096
          AND octet_length(agent_version) BETWEEN 1 AND 4096
          AND octet_length(config_revision) BETWEEN 1 AND 256
        ),
      CONSTRAINT agent_conversations_status_check
        CHECK (status IN ('busy', 'ready')),
      CONSTRAINT agent_conversations_summary_size_check
        CHECK (
          working_summary IS NULL
          OR octet_length(working_summary) <= 65536
        ),
      CONSTRAINT agent_conversations_time_order_check
        CHECK (updated_at >= created_at AND expires_at > created_at)
    );

    CREATE INDEX agent_conversations_owner_updated_idx
      ON agent_conversations (owner_id, updated_at DESC, conversation_id);
    CREATE INDEX agent_conversations_expiry_idx
      ON agent_conversations (expires_at, conversation_id);

    CREATE TABLE agent_conversation_turns (
      schema_version smallint NOT NULL DEFAULT 1,
      turn_id text PRIMARY KEY,
      conversation_id text NOT NULL
        REFERENCES agent_conversations(conversation_id) ON DELETE CASCADE,
      sequence integer NOT NULL,
      status text NOT NULL,
      accepted_input jsonb NOT NULL,
      public_output jsonb,
      error_code text,
      public_error_message text,
      created_at timestamptz NOT NULL,
      started_at timestamptz,
      finished_at timestamptz,
      CONSTRAINT agent_conversation_turns_schema_version_check
        CHECK (schema_version = 1),
      CONSTRAINT agent_conversation_turns_identity_check
        CHECK (octet_length(turn_id) BETWEEN 1 AND 256),
      CONSTRAINT agent_conversation_turns_sequence_check
        CHECK (sequence > 0),
      CONSTRAINT agent_conversation_turns_status_check
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
      CONSTRAINT agent_conversation_turns_input_size_check
        CHECK (octet_length(accepted_input::text) <= 270336),
      CONSTRAINT agent_conversation_turns_output_size_check
        CHECK (
          public_output IS NULL
          OR octet_length(public_output::text) <= 270336
        ),
      CONSTRAINT agent_conversation_turns_error_check
        CHECK (
          error_code IS NULL
          OR error_code IN (
            'AGENT_FAILURE',
            'INTERNAL_ERROR',
            'INVALID_OUTPUT',
            'RESOURCE_UNAVAILABLE'
          )
        ),
      CONSTRAINT agent_conversation_turns_error_message_size_check
        CHECK (
          public_error_message IS NULL
          OR octet_length(public_error_message) <= 4096
        ),
      CONSTRAINT agent_conversation_turns_result_check CHECK (
        (
          status = 'succeeded'
          AND public_output IS NOT NULL
          AND error_code IS NULL
          AND public_error_message IS NULL
        )
        OR (
          status = 'failed'
          AND public_output IS NULL
          AND error_code IS NOT NULL
          AND public_error_message IS NOT NULL
        )
        OR (
          status IN ('queued', 'running')
          AND public_output IS NULL
          AND error_code IS NULL
          AND public_error_message IS NULL
        )
      ),
      CONSTRAINT agent_conversation_turns_started_check
        CHECK ((status = 'queued') = (started_at IS NULL)),
      CONSTRAINT agent_conversation_turns_finished_check
        CHECK ((status IN ('succeeded', 'failed')) = (finished_at IS NOT NULL)),
      CONSTRAINT agent_conversation_turns_time_order_check CHECK (
        (started_at IS NULL OR started_at >= created_at)
        AND (finished_at IS NULL OR finished_at >= started_at)
      ),
      CONSTRAINT agent_conversation_turns_sequence_unique
        UNIQUE (conversation_id, sequence)
    );

    CREATE UNIQUE INDEX agent_conversation_turns_one_active_idx
      ON agent_conversation_turns (conversation_id)
      WHERE status IN ('queued', 'running');
    CREATE INDEX agent_conversation_turns_page_idx
      ON agent_conversation_turns (conversation_id, sequence);

    CREATE TABLE agent_conversation_operations (
      owner_id text NOT NULL,
      idempotency_key text NOT NULL,
      request_fingerprint text NOT NULL,
      conversation_id text NOT NULL
        REFERENCES agent_conversations(conversation_id) ON DELETE CASCADE,
      turn_id text NOT NULL
        REFERENCES agent_conversation_turns(turn_id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL,
      CONSTRAINT agent_conversation_operations_pk
        PRIMARY KEY (owner_id, idempotency_key),
      CONSTRAINT agent_conversation_operations_owner_check
        CHECK (octet_length(owner_id) BETWEEN 1 AND 512),
      CONSTRAINT agent_conversation_operations_key_check
        CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
      CONSTRAINT agent_conversation_operations_fingerprint_check
        CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT agent_conversation_operations_turn_unique UNIQUE (turn_id)
    );

    CREATE TABLE agent_turn_outbox (
      message_id text PRIMARY KEY,
      turn_id text NOT NULL UNIQUE
        REFERENCES agent_conversation_turns(turn_id) ON DELETE CASCADE,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      available_at timestamptz NOT NULL,
      claim_token text,
      claim_expires_at timestamptz,
      published_at timestamptz,
      publish_attempt_count integer NOT NULL DEFAULT 0,
      CONSTRAINT agent_turn_outbox_identity_check
        CHECK (octet_length(message_id) BETWEEN 1 AND 256),
      CONSTRAINT agent_turn_outbox_payload_size_check
        CHECK (octet_length(payload::text) <= 4096),
      CONSTRAINT agent_turn_outbox_attempt_count_check
        CHECK (publish_attempt_count >= 0),
      CONSTRAINT agent_turn_outbox_claim_check
        CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
      CONSTRAINT agent_turn_outbox_claim_token_check
        CHECK (claim_token IS NULL OR octet_length(claim_token) BETWEEN 1 AND 256)
    );

    CREATE INDEX agent_turn_outbox_pending_idx
      ON agent_turn_outbox (available_at, created_at, message_id)
      WHERE published_at IS NULL;
  `);
};

export const down = (pgm) => {
    pgm.sql(`
    DROP TABLE IF EXISTS agent_turn_outbox;
    DROP TABLE IF EXISTS agent_conversation_operations;
    DROP TABLE IF EXISTS agent_conversation_turns;
    DROP TABLE IF EXISTS agent_conversations;
  `);
};
