-- ajent-swarm schema, phase 11: display titles stored in swarm only. The
-- one-shot namer fills the same row; renames from any surface edit it and
-- never touch ajent's own session names or resume targets.

CREATE TABLE IF NOT EXISTS session_titles (
    session_id TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
