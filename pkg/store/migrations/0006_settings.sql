-- ajent-swarm schema, phase 15: swarm-level settings as key/value rows. The
-- session titling model lives here first, so the one-shot namer survives
-- restarts without touching ajent's own config files.

CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
