-- Retention-pruning support for agentic conversations and their turn nodes.
-- cleanupAgenticConversations() selects rows by last_seen_at every 6 hours; without
-- an index that is a full scan of conversation_turn_nodes (2.3M+ rows as of the
-- 2026-11-04 524 incident). Indexes live here, not in the cleanup path, so the
-- build cost is paid once at migration time instead of inside a scheduler tick.

-- agentic_conversations.last_seen_at is already indexed by
-- idx_agentic_conversations_last_seen (migration 155) — do not add a duplicate.

CREATE INDEX IF NOT EXISTS idx_turn_nodes_last_seen ON conversation_turn_nodes(last_seen_at);
