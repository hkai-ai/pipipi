export const up = (pgm) => {
    pgm.sql(`
    ALTER TABLE agent_conversations
      DROP CONSTRAINT agent_conversations_status_check,
      ADD COLUMN revision bigint NOT NULL DEFAULT 0,
      ADD COLUMN deletion_requested_at timestamptz,
      ADD COLUMN expired_at timestamptz,
      ADD COLUMN delete_by timestamptz,
      ADD CONSTRAINT agent_conversations_status_check
        CHECK (status IN ('busy', 'ready', 'deleting', 'expired')),
      ADD CONSTRAINT agent_conversations_revision_check CHECK (revision >= 0),
      ADD CONSTRAINT agent_conversations_deletion_check CHECK (
        (
          status IN ('busy', 'ready')
          AND deletion_requested_at IS NULL
          AND expired_at IS NULL
          AND delete_by IS NULL
        )
        OR (
          status = 'deleting'
          AND deletion_requested_at IS NOT NULL
          AND expired_at IS NULL
          AND delete_by >= deletion_requested_at
        )
        OR (
          status = 'expired'
          AND deletion_requested_at IS NULL
          AND expired_at IS NOT NULL
          AND delete_by >= expired_at
        )
      );

    CREATE INDEX agent_conversations_cleanup_idx
      ON agent_conversations (delete_by, conversation_id)
      WHERE status IN ('deleting', 'expired');

    CREATE TABLE agent_conversation_cleanup_batches (
      cleanup_id text PRIMARY KEY,
      as_of timestamptz NOT NULL,
      cursor_conversation_id text,
      next_cursor_conversation_id text,
      examined_count integer NOT NULL,
      expired_count integer NOT NULL,
      conversation_deleted_count integer NOT NULL,
      resource_reference_deleted_count integer NOT NULL,
      completed_at timestamptz NOT NULL,
      CONSTRAINT agent_conversation_cleanup_batches_identity_check
        CHECK (octet_length(cleanup_id) BETWEEN 1 AND 256),
      CONSTRAINT agent_conversation_cleanup_batches_counts_check CHECK (
        examined_count >= 0
        AND expired_count >= 0
        AND conversation_deleted_count >= 0
        AND resource_reference_deleted_count >= 0
      )
    );
  `);
};

export const down = (pgm) => {
    pgm.sql(`
    DROP TABLE IF EXISTS agent_conversation_cleanup_batches;
    DROP INDEX IF EXISTS agent_conversations_cleanup_idx;

    ALTER TABLE agent_conversations
      DROP CONSTRAINT IF EXISTS agent_conversations_deletion_check,
      DROP CONSTRAINT IF EXISTS agent_conversations_revision_check,
      DROP CONSTRAINT IF EXISTS agent_conversations_status_check,
      DROP COLUMN IF EXISTS delete_by,
      DROP COLUMN IF EXISTS expired_at,
      DROP COLUMN IF EXISTS deletion_requested_at,
      DROP COLUMN IF EXISTS revision,
      ADD CONSTRAINT agent_conversations_status_check
        CHECK (status IN ('busy', 'ready'));
  `);
};
