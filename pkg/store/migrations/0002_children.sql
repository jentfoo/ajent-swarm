-- ajent-swarm schema, phase 04: children swarm spawned, persisted so a
-- restart re-adopts the running ones and exited ones keep their exit facts.

CREATE TABLE IF NOT EXISTS children (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    pid        INTEGER NOT NULL,
    session_id TEXT    NOT NULL DEFAULT '',
    workspace  TEXT    NOT NULL DEFAULT '',
    argv       TEXT    NOT NULL DEFAULT '',
    log_path   TEXT    NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    exited_at  INTEGER NOT NULL DEFAULT 0,
    exit_code  INTEGER,               -- NULL while running, negative when a signal ended it
    exit_note  TEXT    NOT NULL DEFAULT '',
    log_tail   TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_children_session ON children(session_id);
CREATE INDEX IF NOT EXISTS idx_children_running ON children(exited_at);
