-- Chains persist across service restarts: one row per parent-to-child
-- handoff, terminal rows pruned after their retention window.
CREATE TABLE chains (
    id            TEXT PRIMARY KEY,
    parent_id     TEXT NOT NULL,
    child_id      TEXT NOT NULL,
    final_prompt  TEXT NOT NULL DEFAULT '',
    child_prompt  TEXT NOT NULL,
    pending_id    TEXT NOT NULL,
    state         TEXT NOT NULL,
    reason        TEXT NOT NULL DEFAULT '',
    mark          TEXT NOT NULL DEFAULT '', -- the final prompt's committed entry id
    final_at      INTEGER NOT NULL DEFAULT 0,   -- unix ms the final submit landed
    created_at    INTEGER NOT NULL,   -- unix milliseconds
    updated_at    INTEGER NOT NULL
);
