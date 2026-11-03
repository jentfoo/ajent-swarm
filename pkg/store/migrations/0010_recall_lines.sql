-- ajent-swarm schema: workspace-wide prompt recall. One submitted typed line
-- per row, keyed by workspace; swarm's own mirror of ajent's recall scope so
-- a prompt sent from the web recalls in every surface on that workspace. A
-- withheld row keeps its id with an empty text, per the secret discipline.

CREATE TABLE IF NOT EXISTS recall_lines (
    id         INTEGER PRIMARY KEY,
    workspace  TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL -- unix milliseconds
);

CREATE INDEX IF NOT EXISTS idx_recall_lines_workspace
    ON recall_lines (workspace, created_at, id);
