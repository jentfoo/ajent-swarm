-- ajent-swarm schema, phase 06: scheduled jobs and their run history.

CREATE TABLE IF NOT EXISTS jobs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL UNIQUE,
    workspace        TEXT    NOT NULL DEFAULT '',
    command_prefix   TEXT    NOT NULL DEFAULT '',
    prompt           TEXT    NOT NULL DEFAULT '',
    spawn_mode       TEXT    NOT NULL DEFAULT 'new',
    session_target   TEXT    NOT NULL DEFAULT '',
    model            TEXT    NOT NULL DEFAULT '',
    permission       TEXT    NOT NULL DEFAULT '',
    enabled          INTEGER NOT NULL DEFAULT 1,
    schedule_kind    TEXT    NOT NULL DEFAULT 'once',  -- once | interval | daily
    interval_seconds INTEGER NOT NULL DEFAULT 0,
    daily_time       TEXT    NOT NULL DEFAULT '',      -- HH:MM wall clock in tz
    tz               TEXT    NOT NULL DEFAULT '',      -- IANA name, empty = server local
    next_run_at      INTEGER,                          -- unix seconds; NULL when unscheduled
    on_missed        TEXT    NOT NULL DEFAULT 'skip',  -- skip | fire_late
    overlap          TEXT    NOT NULL DEFAULT 'run',   -- run | skip_if_running
    timeout_minutes  INTEGER NOT NULL DEFAULT 0,       -- 0 = service default
    keep_alive       INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      INTEGER,                    -- nullable: manual ad-hoc runs stand alone
    session_id  TEXT    NOT NULL DEFAULT '',
    prompt      TEXT    NOT NULL DEFAULT '',
    trigger     TEXT    NOT NULL DEFAULT 'schedule', -- schedule | manual
    status       TEXT   NOT NULL DEFAULT 'running',
    started_at   INTEGER NOT NULL, -- unix milliseconds
    finished_at  INTEGER NOT NULL DEFAULT 0,
    error       TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id, id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
