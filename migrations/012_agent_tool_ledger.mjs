export const up = (pgm) => {
    pgm.sql(`
    ALTER TABLE agent_conversation_turns
      DROP CONSTRAINT agent_conversation_turns_error_check,
      ADD CONSTRAINT agent_conversation_turns_error_check
        CHECK (
          error_code IS NULL
          OR error_code IN (
            'AGENT_FAILURE',
            'DEPENDENCY_FAILURE_AFTER_COMMIT',
            'INTERNAL_ERROR',
            'INVALID_OUTPUT',
            'RESOURCE_UNAVAILABLE'
          )
        );

    CREATE TABLE agent_tool_invocations (
      invocation_id text PRIMARY KEY,
      conversation_id text NOT NULL
        REFERENCES agent_conversations(conversation_id) ON DELETE CASCADE,
      turn_id text NOT NULL
        REFERENCES agent_conversation_turns(turn_id) ON DELETE CASCADE,
      invocation integer NOT NULL,
      tool_name text NOT NULL,
      process_id text NOT NULL,
      process_version text NOT NULL,
      input_fingerprint text NOT NULL,
      side_effect text NOT NULL,
      child_run_id text NOT NULL UNIQUE,
      status text NOT NULL,
      execution_token text,
      revision bigint NOT NULL DEFAULT 0,
      public_output jsonb,
      error_code text,
      public_error_message text,
      created_at timestamptz NOT NULL,
      started_at timestamptz,
      finished_at timestamptz,
      updated_at timestamptz NOT NULL,
      CONSTRAINT agent_tool_invocations_turn_ordinal_unique
        UNIQUE (turn_id, invocation),
      CONSTRAINT agent_tool_invocations_identity_check CHECK (
        octet_length(invocation_id) BETWEEN 1 AND 256
        AND octet_length(child_run_id) BETWEEN 1 AND 256
        AND octet_length(tool_name) BETWEEN 1 AND 64
        AND octet_length(process_id) BETWEEN 1 AND 4096
        AND octet_length(process_version) BETWEEN 1 AND 4096
      ),
      CONSTRAINT agent_tool_invocations_number_check CHECK (invocation > 0),
      CONSTRAINT agent_tool_invocations_fingerprint_check
        CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT agent_tool_invocations_side_effect_check
        CHECK (side_effect IN ('none', 'priced')),
      CONSTRAINT agent_tool_invocations_status_check
        CHECK (status IN ('prepared', 'executing', 'succeeded', 'failed', 'uncertain')),
      CONSTRAINT agent_tool_invocations_execution_check CHECK (
        (status = 'executing') = (execution_token IS NOT NULL)
        AND (execution_token IS NULL OR octet_length(execution_token) BETWEEN 1 AND 256)
      ),
      CONSTRAINT agent_tool_invocations_revision_check CHECK (revision >= 0),
      CONSTRAINT agent_tool_invocations_output_size_check CHECK (
        public_output IS NULL OR octet_length(public_output::text) <= 270336
      ),
      CONSTRAINT agent_tool_invocations_error_size_check CHECK (
        error_code IS NULL OR octet_length(error_code) BETWEEN 1 AND 128
      ),
      CONSTRAINT agent_tool_invocations_error_message_size_check CHECK (
        public_error_message IS NULL
        OR octet_length(public_error_message) BETWEEN 1 AND 4096
      ),
      CONSTRAINT agent_tool_invocations_result_check CHECK (
        (
          status = 'succeeded'
          AND public_output IS NOT NULL
          AND error_code IS NULL
          AND public_error_message IS NULL
        )
        OR (
          status IN ('failed', 'uncertain')
          AND public_output IS NULL
          AND error_code IS NOT NULL
          AND public_error_message IS NOT NULL
        )
        OR (
          status IN ('prepared', 'executing')
          AND public_output IS NULL
          AND error_code IS NULL
          AND public_error_message IS NULL
        )
      ),
      CONSTRAINT agent_tool_invocations_time_order_check CHECK (
        updated_at >= created_at
        AND (started_at IS NULL OR started_at >= created_at)
        AND (finished_at IS NULL OR finished_at >= started_at)
        AND ((status IN ('succeeded', 'failed', 'uncertain')) = (finished_at IS NOT NULL))
      )
    );

    CREATE INDEX agent_tool_invocations_turn_idx
      ON agent_tool_invocations (turn_id, invocation);
    CREATE INDEX agent_tool_invocations_conversation_budget_idx
      ON agent_tool_invocations (conversation_id, side_effect, invocation_id);
    CREATE INDEX agent_tool_invocations_status_idx
      ON agent_tool_invocations (status, updated_at, invocation_id);
  `);
};

export const down = (pgm) => {
    pgm.sql(`
    DROP TABLE IF EXISTS agent_tool_invocations;

    ALTER TABLE agent_conversation_turns
      DROP CONSTRAINT agent_conversation_turns_error_check,
      ADD CONSTRAINT agent_conversation_turns_error_check
        CHECK (
          error_code IS NULL
          OR error_code IN (
            'AGENT_FAILURE',
            'INTERNAL_ERROR',
            'INVALID_OUTPUT',
            'RESOURCE_UNAVAILABLE'
          )
        );
  `);
};
