-- ajent-swarm schema: external sessions persist beside swarm children, so a
-- CLI/TUI session keeps its listing row after its registry record leaves.
-- Legacy rows read as swarm; argv and log_path relax to nullable because
-- externals have neither. Rebuilding the table is the only way to relax the
-- NOT NULL columns.

CREATE TABLE children_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    pid          INTEGER NOT NULL,
    session_id   TEXT    NOT NULL DEFAULT '',
    session_name TEXT    NOT NULL DEFAULT '',
    workspace    TEXT    NOT NULL DEFAULT '',
    argv         TEXT,                  -- NULL for externals: swarm never launched them
    log_path     TEXT,                  -- NULL for externals: no child log exists
    started_at   INTEGER NOT NULL,
    exited_at    INTEGER NOT NULL DEFAULT 0,
    exit_code    INTEGER,               -- NULL while running, negative when a signal ended it
    exit_note    TEXT    NOT NULL DEFAULT '',
    log_tail     TEXT    NOT NULL DEFAULT '',
    origin       TEXT    NOT NULL DEFAULT 'swarm'
);

INSERT INTO children_new (id, pid, session_id, session_name, workspace, argv, log_path,
    started_at, exited_at, exit_code, exit_note, log_tail, origin)
SELECT id, pid, session_id, '', workspace, argv, log_path,
    started_at, exited_at, exit_code, exit_note, log_tail, 'swarm'
FROM children;

DROP TABLE children;
ALTER TABLE children_new RENAME TO children;

CREATE INDEX IF NOT EXISTS idx_children_session ON children(session_id);
CREATE INDEX IF NOT EXISTS idx_children_running ON children(exited_at);
