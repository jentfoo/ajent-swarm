-- ajent-swarm schema: attention acknowledgments as server state, so one
-- check-off settles the row for every device. One row per settled dialog
-- keyed by session plus pid (a restarted process renumbers dialog ids), and
-- one row per session for the acknowledged turn-end watermark. Dialog rows
-- keep a per-session bound, oldest dropped, mirroring the client ledger this
-- replaces. No localStorage acks import: attention items settle again or
-- expire naturally.

CREATE TABLE IF NOT EXISTS attention_dialog_acks (
    session_id TEXT    NOT NULL,
    pid        INTEGER NOT NULL,
    dialog_id  INTEGER NOT NULL,
    acked_at   INTEGER NOT NULL, -- unix milliseconds
    PRIMARY KEY (session_id, pid, dialog_id)
);

CREATE INDEX IF NOT EXISTS idx_attention_dialog_acks_prune
    ON attention_dialog_acks (session_id, acked_at);

CREATE TABLE IF NOT EXISTS attention_turn_acks (
    session_id TEXT   PRIMARY KEY,
    turn_end   INTEGER NOT NULL, -- unix milliseconds watermark
    acked_at   INTEGER NOT NULL
);
