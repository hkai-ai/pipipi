export const up = (pgm) => {
    pgm.sql(`
    ALTER TABLE agent_conversation_turns
      DROP CONSTRAINT agent_conversation_turns_started_check;

    ALTER TABLE agent_conversation_turns
      ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
      ADD COLUMN revision bigint NOT NULL DEFAULT 0,
      ADD COLUMN claim_token text,
      ADD COLUMN claim_expires_at timestamptz,
      ADD CONSTRAINT agent_conversation_turns_attempt_count_check
        CHECK (attempt_count >= 0),
      ADD CONSTRAINT agent_conversation_turns_revision_check
        CHECK (revision >= 0),
      ADD CONSTRAINT agent_conversation_turns_claim_check CHECK (
        (status = 'running') =
          (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
      ),
      ADD CONSTRAINT agent_conversation_turns_claim_token_check
        CHECK (claim_token IS NULL OR octet_length(claim_token) BETWEEN 1 AND 256),
      ADD CONSTRAINT agent_conversation_turns_started_check CHECK (
        status = 'queued' OR started_at IS NOT NULL
      );

    CREATE INDEX agent_conversation_turns_claim_expiry_idx
      ON agent_conversation_turns (claim_expires_at, turn_id)
      WHERE status = 'running';

    CREATE TABLE agent_turn_attempts (
      turn_id text NOT NULL
        REFERENCES agent_conversation_turns(turn_id) ON DELETE CASCADE,
      attempt_number integer NOT NULL,
      claim_token text NOT NULL,
      status text NOT NULL,
      started_at timestamptz NOT NULL,
      finished_at timestamptz,
      result_code text,
      CONSTRAINT agent_turn_attempts_pk PRIMARY KEY (turn_id, attempt_number),
      CONSTRAINT agent_turn_attempts_claim_unique UNIQUE (claim_token),
      CONSTRAINT agent_turn_attempts_number_check CHECK (attempt_number > 0),
      CONSTRAINT agent_turn_attempts_status_check
        CHECK (status IN ('running', 'succeeded', 'failed', 'abandoned')),
      CONSTRAINT agent_turn_attempts_finished_check
        CHECK ((status = 'running') = (finished_at IS NULL))
    );

    CREATE INDEX agent_turn_attempts_status_idx
      ON agent_turn_attempts (status, started_at, turn_id);
  `);
};

export const down = (pgm) => {
    pgm.sql(`
    DROP TABLE IF EXISTS agent_turn_attempts;
    DROP INDEX IF EXISTS agent_conversation_turns_claim_expiry_idx;

    ALTER TABLE agent_conversation_turns
      DROP CONSTRAINT IF EXISTS agent_conversation_turns_started_check,
      DROP CONSTRAINT IF EXISTS agent_conversation_turns_claim_token_check,
      DROP CONSTRAINT IF EXISTS agent_conversation_turns_claim_check,
      DROP CONSTRAINT IF EXISTS agent_conversation_turns_revision_check,
      DROP CONSTRAINT IF EXISTS agent_conversation_turns_attempt_count_check,
      DROP COLUMN IF EXISTS claim_expires_at,
      DROP COLUMN IF EXISTS claim_token,
      DROP COLUMN IF EXISTS revision,
      DROP COLUMN IF EXISTS attempt_count,
      ADD CONSTRAINT agent_conversation_turns_started_check
        CHECK ((status = 'queued') = (started_at IS NULL));
  `);
};
