-- ajent-swarm schema: first-release baseline collapsing all pre-release
-- migrations into one file; later changes add new numbered files above it.

CREATE TABLE IF NOT EXISTS users (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash   TEXT PRIMARY KEY,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL DEFAULT 0
);

-- Children swarm spawned plus external sessions: a restart re-adopts the
-- running ones, exited ones keep their exit facts. Externals have no argv or
-- child log; legacy rows read as swarm.
CREATE TABLE IF NOT EXISTS children (
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

CREATE INDEX IF NOT EXISTS idx_children_session ON children(session_id);
CREATE INDEX IF NOT EXISTS idx_children_running ON children(exited_at);

-- Scheduled jobs and their run history.
CREATE TABLE IF NOT EXISTS jobs (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    name                   TEXT    NOT NULL UNIQUE,
    workspace              TEXT    NOT NULL DEFAULT '',
    command_prefix         TEXT    NOT NULL DEFAULT '',
    prompt                 TEXT    NOT NULL DEFAULT '',
    spawn_mode             TEXT    NOT NULL DEFAULT 'new',
    session_target         TEXT    NOT NULL DEFAULT '',
    model                  TEXT    NOT NULL DEFAULT '',
    permission             TEXT    NOT NULL DEFAULT '',
    enabled                INTEGER NOT NULL DEFAULT 1,
    schedule_kind          TEXT    NOT NULL DEFAULT 'once',    -- once | interval | daily
    interval_seconds       INTEGER NOT NULL DEFAULT 0,
    daily_time             TEXT    NOT NULL DEFAULT '',        -- HH:MM wall clock in tz
    tz                     TEXT    NOT NULL DEFAULT '',        -- IANA name, empty = server local
    next_run_at            INTEGER,                            -- unix seconds; NULL when unscheduled
    on_missed              TEXT    NOT NULL DEFAULT 'skip',    -- skip | fire_late
    overlap                TEXT    NOT NULL DEFAULT 'run',     -- run | skip_if_running
    timeout_minutes        INTEGER NOT NULL DEFAULT 0,         -- 0 = service default
    keep_alive             INTEGER NOT NULL DEFAULT 0,
    created_at             INTEGER NOT NULL,
    weekdays               TEXT    NOT NULL DEFAULT '',        -- comma list of sun..sat
    run_when_idle          INTEGER NOT NULL DEFAULT 0,
    idle_max_delay_seconds INTEGER NOT NULL DEFAULT 0,         -- 0 = wait forever
    trigger_command        TEXT    NOT NULL DEFAULT '',
    trigger_on             TEXT    NOT NULL DEFAULT 'success', -- success | error
    tools                  TEXT    NOT NULL DEFAULT '',        -- comma list of enabled tool names
    tools_custom           INTEGER NOT NULL DEFAULT 0,
    queued                 INTEGER NOT NULL DEFAULT 0          -- queued one-shot prompt stored as a job
);

CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      INTEGER,                     -- nullable: manual ad-hoc runs stand alone
    session_id  TEXT    NOT NULL DEFAULT '',
    prompt      TEXT    NOT NULL DEFAULT '',
    trigger     TEXT    NOT NULL DEFAULT 'schedule', -- schedule | manual
    status      TEXT    NOT NULL DEFAULT 'running',
    started_at  INTEGER NOT NULL,                   -- unix milliseconds
    finished_at INTEGER NOT NULL DEFAULT 0,
    error       TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id, id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

-- Display titles stored in swarm only; edits never touch ajent's own session
-- names or resume targets.
CREATE TABLE IF NOT EXISTS session_titles (
    session_id TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Swarm-level key/value settings, so state like the titling model survives
-- restarts without touching ajent's config files.
CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Workspace-wide prompt recall, one submitted typed line per row. A withheld
-- row keeps its id with an empty text, per the secret discipline.
CREATE TABLE IF NOT EXISTS recall_lines (
    id         INTEGER PRIMARY KEY,
    workspace  TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL -- unix milliseconds
);

CREATE INDEX IF NOT EXISTS idx_recall_lines_workspace
    ON recall_lines (workspace, created_at, id);

-- Attention acknowledgments as server state, so one check-off settles the row
-- for every device. Dialog rows key on pid because a restarted process
-- renumbers dialog ids; turn acks watermark per session.
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
