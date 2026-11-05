package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Vocabulary persisted in the jobs and runs tables. Values are wire-visible
// through the API, so they stay stable strings.
const (
	ScheduleOnce     = "once"
	ScheduleInterval = "interval"
	ScheduleDaily    = "daily"

	MissSkip     = "skip"      // past grace: advance to the next future slot
	MissFireLate = "fire_late" // past grace: fire once late, then resume cadence

	OverlapRun           = "run"             // always run, even over a live previous run
	OverlapSkipIfRunning = "skip_if_running" // skip while the previous run is still live

	TriggerSchedule = "schedule"
	TriggerManual   = "manual"

	// TriggerOnSuccess lets a gated job run when its trigger command exits zero.
	TriggerOnSuccess = "success"
	// TriggerOnError lets a gated job run when its trigger command exits non-zero.
	TriggerOnError = "error"

	RunRunning       = "running"
	RunAwaitingInput = "awaiting_input" // parked at an open dialog
	RunOK            = "ok"
	RunFailed        = "failed"
	RunTimeout       = "timeout"
	RunSkipped       = "skipped" // recorded without launching: missed, overlap or capacity
)

// liveRunStatuses are the statuses of runs that still occupy their slot.
const liveRunStatuses = `('running','awaiting_input')`

// ErrLiveRun reports a fire refused by the job's skip-if-running policy.
var ErrLiveRun = errors.New("previous run is still active")

// ErrCapacity reports a fire refused because the global run limit is reached.
var ErrCapacity = errors.New("global run limit reached")

// Job is one row of the jobs table: what to launch, when and how. NextRunAt
// is nil while the job is disabled or has nothing left to fire; TimeoutMinutes
// zero means the service default applies.
type Job struct {
	ID                  int64      `json:"id"`
	Name                string     `json:"name"`
	Workspace           string     `json:"workspace"`
	CommandPrefix       string     `json:"commandPrefix,omitempty"`
	Prompt              string     `json:"prompt,omitempty"`
	SpawnMode           string     `json:"spawnMode"` // new, resume, continue or session
	SessionTarget       string     `json:"sessionTarget,omitempty"`
	Model               string     `json:"model,omitempty"`
	Permission          string     `json:"permission,omitempty"`
	Tools               string     `json:"tools,omitempty"` // enabled tool names
	ToolsCustom         bool       `json:"toolsCustom"`     // off keeps the launch defaults
	Enabled             bool       `json:"enabled"`
	ScheduleKind        string     `json:"scheduleKind"` // once, interval or daily
	IntervalSeconds     int        `json:"intervalSeconds,omitempty"`
	DailyTime           string     `json:"dailyTime,omitempty"` // HH:MM wall clock in TZ
	TZ                  string     `json:"tz,omitempty"`        // IANA name; empty means server local
	Weekdays            string     `json:"weekdays,omitempty"`  // sun..sat; empty = every day
	NextRunAt           *time.Time `json:"nextRunAt"`
	OnMissed            string     `json:"onMissed"`
	Overlap             string     `json:"overlap"`
	TimeoutMinutes      int        `json:"timeoutMinutes,omitempty"`
	KeepAlive           bool       `json:"keepAlive"`
	RunWhenIdle         bool       `json:"runWhenIdle"`                   // fire only when idle
	IdleMaxDelaySeconds int        `json:"idleMaxDelaySeconds,omitempty"` // idle wait cap; 0=forever
	TriggerCommand      string     `json:"triggerCommand,omitempty"`      // pre-launch shell gate
	TriggerOn           string     `json:"triggerOn,omitempty"`           // success (zero) or error
	CreatedAt           time.Time  `json:"createdAt"`
}

// Run is one row of the runs table: a single fire of a job, manual or
// scheduled. SessionID stays empty until the launch path returned one; a run
// skipped before launching never gets one.
type Run struct {
	ID         int64      `json:"id"`
	JobID      *int64     `json:"jobId,omitempty"` // null for manual ad-hoc runs
	SessionID  string     `json:"sessionId,omitempty"`
	Prompt     string     `json:"prompt,omitempty"`
	Trigger    string     `json:"trigger"`
	Status     string     `json:"status"`
	StartedAt  time.Time  `json:"startedAt"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
	Error      string     `json:"error,omitempty"`
}

// CreateJob inserts one job row and returns its id; a duplicate name reports
// ErrConflict.
func (s *Store) CreateJob(ctx context.Context, j Job) (int64, error) {
	const q = `INSERT INTO jobs
        (name, workspace, command_prefix, prompt, spawn_mode, session_target,
         model, permission, tools, tools_custom, enabled, schedule_kind,
         interval_seconds, daily_time, tz, weekdays, next_run_at, on_missed,
         overlap, timeout_minutes, keep_alive, run_when_idle,
         idle_max_delay_seconds, trigger_command, trigger_on, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?)`
	res, err := s.db.ExecContext(ctx, q,
		j.Name, j.Workspace, j.CommandPrefix, j.Prompt, j.SpawnMode, j.SessionTarget,
		j.Model, j.Permission, j.Tools, boolInt(j.ToolsCustom), boolInt(j.Enabled),
		j.ScheduleKind, j.IntervalSeconds, j.DailyTime, j.TZ, j.Weekdays,
		unixSecPtr(j.NextRunAt), j.OnMissed, j.Overlap, j.TimeoutMinutes,
		boolInt(j.KeepAlive), boolInt(j.RunWhenIdle), j.IdleMaxDelaySeconds,
		j.TriggerCommand, j.TriggerOn, unixSec(j.CreatedAt))
	if isUniqueViolation(err) {
		return 0, fmt.Errorf("%w: job %q", ErrConflict, j.Name)
	} else if err != nil {
		return 0, fmt.Errorf("insert job: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("insert job: %w", err)
	}
	return id, nil
}

// UpdateJob writes every mutable column of one job row, by id. A duplicate
// name reports ErrConflict.
func (s *Store) UpdateJob(ctx context.Context, j Job) error {
	const q = `UPDATE jobs SET
        name = ?, workspace = ?, command_prefix = ?, prompt = ?, spawn_mode = ?,
        session_target = ?, model = ?, permission = ?, tools = ?,
        tools_custom = ?, enabled = ?, schedule_kind = ?, interval_seconds = ?,
        daily_time = ?, tz = ?, weekdays = ?, next_run_at = ?, on_missed = ?,
        overlap = ?, timeout_minutes = ?, keep_alive = ?, run_when_idle = ?,
        idle_max_delay_seconds = ?, trigger_command = ?, trigger_on = ?
        WHERE id = ?`
	res, err := s.db.ExecContext(ctx, q,
		j.Name, j.Workspace, j.CommandPrefix, j.Prompt, j.SpawnMode,
		j.SessionTarget, j.Model, j.Permission, j.Tools, boolInt(j.ToolsCustom),
		boolInt(j.Enabled), j.ScheduleKind, j.IntervalSeconds, j.DailyTime,
		j.TZ, j.Weekdays, unixSecPtr(j.NextRunAt), j.OnMissed, j.Overlap,
		j.TimeoutMinutes, boolInt(j.KeepAlive), boolInt(j.RunWhenIdle),
		j.IdleMaxDelaySeconds, j.TriggerCommand, j.TriggerOn, j.ID)
	if isUniqueViolation(err) {
		return fmt.Errorf("%w: job %q", ErrConflict, j.Name)
	} else if err != nil {
		return fmt.Errorf("update job %d: %w", j.ID, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteJob removes one job row and unlinks its runs in one transaction.
func (s *Store) DeleteJob(ctx context.Context, id int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("delete job %d: %w", id, err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err = tx.ExecContext(ctx, `UPDATE runs SET job_id = NULL WHERE job_id = ?`, id); err != nil {
		return fmt.Errorf("delete job %d: %w", id, err)
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM jobs WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete job %d: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return tx.Commit()
}

// JobByID returns one job by id.
func (s *Store) JobByID(ctx context.Context, id int64) (Job, error) {
	const q = `SELECT ` + jobColumns + ` FROM jobs WHERE id = ?`
	jobs, err := s.queryJobs(ctx, q, id)
	if err != nil {
		return Job{}, err
	}
	if len(jobs) == 0 {
		return Job{}, ErrNotFound
	}
	return jobs[0], nil
}

// Jobs returns every job row ordered by id.
func (s *Store) Jobs(ctx context.Context) ([]Job, error) {
	const q = `SELECT ` + jobColumns + ` FROM jobs ORDER BY id`
	return s.queryJobs(ctx, q)
}

// DueJobs returns every enabled job whose next run is at or before now,
// oldest due slot first.
func (s *Store) DueJobs(ctx context.Context, now time.Time) ([]Job, error) {
	const q = `SELECT ` + jobColumns + ` FROM jobs
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at, id`
	return s.queryJobs(ctx, q, unixSec(now))
}

// EarliestNextRun returns the soonest scheduled fire among enabled jobs, or
// nil when nothing is scheduled.
func (s *Store) EarliestNextRun(ctx context.Context) (*time.Time, error) {
	var sec sql.NullInt64
	const q = `SELECT MIN(next_run_at) FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL`
	if err := s.db.QueryRowContext(ctx, q).Scan(&sec); err != nil {
		return nil, fmt.Errorf("read earliest next run: %w", err)
	}
	if !sec.Valid {
		return nil, nil
	}
	t := fromUnixSec(sec.Int64)
	return &t, nil
}

// jobColumns is the projection every jobs query reads.
const jobColumns = `id, name, workspace, command_prefix, prompt, spawn_mode,
    session_target, model, permission, tools, tools_custom, enabled,
    schedule_kind, interval_seconds, daily_time, tz, weekdays, next_run_at,
    on_missed, overlap, timeout_minutes, keep_alive, run_when_idle,
    idle_max_delay_seconds, trigger_command, trigger_on, created_at`

// queryJobs runs one jobs query with its arguments.
func (s *Store) queryJobs(ctx context.Context, q string, args ...any) ([]Job, error) {
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("read jobs: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []Job
	for rows.Next() {
		j, scanErr := scanJob(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		out = append(out, j)
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("read jobs: %w", err)
	}
	return out, nil
}

// scanJob decodes one jobs row.
func scanJob(row interface{ Scan(...any) error }) (Job, error) {
	var (
		j            Job
		nextRun      sql.NullInt64
		enabled      int64
		toolsCustom  int64
		keepAlive    int64
		runWhenIdle  int64
		idleMaxDelay int64
		createdAt    int64
	)
	if err := row.Scan(&j.ID, &j.Name, &j.Workspace, &j.CommandPrefix, &j.Prompt,
		&j.SpawnMode, &j.SessionTarget, &j.Model, &j.Permission, &j.Tools,
		&toolsCustom, &enabled, &j.ScheduleKind, &j.IntervalSeconds, &j.DailyTime,
		&j.TZ, &j.Weekdays, &nextRun, &j.OnMissed, &j.Overlap, &j.TimeoutMinutes,
		&keepAlive, &runWhenIdle, &idleMaxDelay, &j.TriggerCommand, &j.TriggerOn,
		&createdAt); err != nil {
		return Job{}, fmt.Errorf("scan job: %w", err)
	}
	j.Enabled = enabled != 0
	j.ToolsCustom = toolsCustom != 0
	j.KeepAlive = keepAlive != 0
	j.RunWhenIdle = runWhenIdle != 0
	j.IdleMaxDelaySeconds = int(idleMaxDelay)
	j.CreatedAt = fromUnixSec(createdAt)
	if nextRun.Valid && nextRun.Int64 != 0 {
		t := fromUnixSec(nextRun.Int64)
		j.NextRunAt = &t
	}
	return j, nil
}

// StartScheduledFire claims one due fire atomically: the optimistic
// next_run_at update and the run row land in one transaction, so restarts and
// concurrent triggers never double-fire. The claimed slot must still equal
// expectedNext; a lost claim returns claimed false without touching anything.
// A job whose skip-if-running policy finds a live previous run, or a fire past
// maxConcurrent live runs overall, records status skipped with the reason.
func (s *Store) StartScheduledFire(ctx context.Context, jobID int64,
	expectedNext time.Time, newNext *time.Time, enforceOverlap bool,
	maxConcurrent int, run Run,
) (id int64, status string, claimed bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, "", false, fmt.Errorf("fire job %d: %w", jobID, err)
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(ctx,
		`UPDATE jobs SET next_run_at = ? WHERE id = ? AND next_run_at = ?`,
		unixSecPtr(newNext), jobID, unixSec(expectedNext))
	if err != nil {
		return 0, "", false, fmt.Errorf("fire job %d: %w", jobID, err)
	}
	if n, _ := res.RowsAffected(); n == 0 { // advanced or deleted elsewhere
		return 0, "", false, nil
	}

	final := run.Status // honor a pre-decided skip; guards may flip it too
	liveJob, err := countLiveRunsTx(ctx, tx, jobID)
	if err != nil {
		return 0, "", false, err
	}
	liveAll, err := countLiveRunsTx(ctx, tx, 0)
	if err != nil {
		return 0, "", false, err
	}
	switch {
	case enforceOverlap && liveJob > 0:
		final = RunSkipped
		run.Status, run.Error = final, "skipped: previous run is still active"
	case int(liveAll) >= maxConcurrent:
		final = RunSkipped
		run.Status, run.Error = final, "skipped: global run limit reached"
	}

	id, err = insertRunTx(ctx, tx, run)
	if err != nil {
		return 0, "", false, err
	}
	if err = tx.Commit(); err != nil {
		return 0, "", false, fmt.Errorf("fire job %d: %w", jobID, err)
	}
	return id, final, true, nil
}

// BeginManualRun records a manual fire of one job without touching its
// schedule. The job's skip-if-running policy and the global run limit refuse
// with ErrLiveRun or ErrCapacity instead of creating a row.
func (s *Store) BeginManualRun(ctx context.Context, jobID int64,
	enforceOverlap bool, maxConcurrent int, run Run,
) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("manual fire job %d: %w", jobID, err)
	}
	defer func() { _ = tx.Rollback() }()

	liveJob, err := countLiveRunsTx(ctx, tx, jobID)
	if err != nil {
		return 0, err
	}
	if enforceOverlap && liveJob > 0 {
		return 0, fmt.Errorf("manual fire job %d: %w", jobID, ErrLiveRun)
	}
	liveAll, err := countLiveRunsTx(ctx, tx, 0)
	if err != nil {
		return 0, err
	}
	if int(liveAll) >= maxConcurrent {
		return 0, fmt.Errorf("manual fire job %d: %w", jobID, ErrCapacity)
	}

	id, err := insertRunTx(ctx, tx, run)
	if err != nil {
		return 0, err
	}
	return id, tx.Commit()
}

// countLiveRunsTx counts running or awaiting runs, optionally one job's only;
// a zero jobID counts across every job. tx must be live.
func countLiveRunsTx(ctx context.Context, tx *sql.Tx, jobID int64) (int64, error) {
	q := `SELECT COUNT(*) FROM runs WHERE status IN ` + liveRunStatuses
	var args []any
	if jobID > 0 {
		q += ` AND job_id = ?`
		args = append(args, jobID)
	}
	var n int64
	if err := tx.QueryRowContext(ctx, q, args...).Scan(&n); err != nil {
		return 0, fmt.Errorf("count live runs: %w", err)
	}
	return n, nil
}

// insertRunTx inserts one run row inside a transaction and returns its id.
func insertRunTx(ctx context.Context, tx *sql.Tx, r Run) (int64, error) {
	const q = `INSERT INTO runs (job_id, session_id, prompt, trigger, status,
        started_at, finished_at, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	var jobID any
	if r.JobID != nil {
		jobID = *r.JobID
	}
	res, err := tx.ExecContext(ctx, q,
		jobID, r.SessionID, r.Prompt, r.Trigger, r.Status,
		unixMilli(r.StartedAt), unixMilliOrZero(r.FinishedAt), r.Error)
	if err != nil {
		return 0, fmt.Errorf("insert run: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("insert run: %w", err)
	}
	return id, nil
}

// UpdateRun writes the mutable columns of one run row.
func (s *Store) UpdateRun(ctx context.Context, r Run) error {
	const q = `UPDATE runs SET
        session_id = ?, prompt = ?, status = ?, finished_at = ?, error = ?
        WHERE id = ?`
	res, err := s.db.ExecContext(ctx, q,
		r.SessionID, r.Prompt, r.Status, unixMilliOrZero(r.FinishedAt), r.Error, r.ID)
	if err != nil {
		return fmt.Errorf("update run %d: %w", r.ID, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// RunByID returns one run row by id.
func (s *Store) RunByID(ctx context.Context, id int64) (Run, error) {
	const q = `SELECT ` + runColumns + ` FROM runs WHERE id = ?`
	runs, err := s.queryRuns(ctx, q, id)
	if err != nil {
		return Run{}, err
	}
	if len(runs) == 0 {
		return Run{}, ErrNotFound
	}
	return runs[0], nil
}

// Runs returns run rows newest first. A zero jobID lists every job's runs.
func (s *Store) Runs(ctx context.Context, jobID int64, limit int) ([]Run, error) {
	q := `SELECT ` + runColumns + ` FROM runs`
	var args []any
	if jobID > 0 {
		q += ` WHERE job_id = ?`
		args = append(args, jobID)
	}
	q += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)
	return s.queryRuns(ctx, q, args...)
}

// runColumns is the projection every runs query reads.
const runColumns = `id, job_id, session_id, prompt, trigger, status,
    started_at, finished_at, error`

// queryRuns runs one runs query with its arguments.
func (s *Store) queryRuns(ctx context.Context, q string, args ...any) ([]Run, error) {
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("read runs: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []Run
	for rows.Next() {
		r, scanErr := scanRun(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		out = append(out, r)
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("read runs: %w", err)
	}
	return out, nil
}

// FailInterruptedRuns marks every live run failed with the given reason. Run
// watchers never survive a service restart, so startup sweeps them once.
func (s *Store) FailInterruptedRuns(ctx context.Context, now time.Time, reason string) (int64, error) {
	q := `UPDATE runs SET status = ?, finished_at = ?,
        error = CASE WHEN error = '' THEN ? ELSE error || ' (' || ? || ')' END
        WHERE status IN ` + liveRunStatuses
	res, err := s.db.ExecContext(ctx, q, RunFailed, unixMilli(now), reason, reason)
	if err != nil {
		return 0, fmt.Errorf("fail interrupted runs: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("fail interrupted runs: %w", err)
	}
	return n, nil
}

// PruneRuns deletes run rows older than cutoff and then keeps at most keepMax
// of the newest; zero keepMax skips the count cap. Returns how many rows went.
func (s *Store) PruneRuns(ctx context.Context, cutoff time.Time, keepMax int) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM runs WHERE started_at < ?`, unixMilli(cutoff))
	if err != nil {
		return 0, fmt.Errorf("prune runs: %w", err)
	}
	total, _ := res.RowsAffected()

	if keepMax > 0 {
		res, err = s.db.ExecContext(ctx, `DELETE FROM runs WHERE id IN (
            SELECT id FROM runs ORDER BY id DESC LIMIT -1 OFFSET ?)`, keepMax)
		if err != nil {
			return total, fmt.Errorf("prune runs: %w", err)
		}
		n, _ := res.RowsAffected()
		total += n
	}
	return total, nil
}

// scanRun decodes one runs row.
func scanRun(row interface{ Scan(...any) error }) (Run, error) {
	var (
		r         Run
		jobID     sql.NullInt64
		startedAt int64
		finished  sql.NullInt64
	)
	if err := row.Scan(&r.ID, &jobID, &r.SessionID, &r.Prompt, &r.Trigger,
		&r.Status, &startedAt, &finished, &r.Error); err != nil {
		return Run{}, fmt.Errorf("scan run: %w", err)
	}
	if jobID.Valid {
		id := jobID.Int64
		r.JobID = &id
	}
	r.StartedAt = fromUnixMilli(startedAt)
	if finished.Valid && finished.Int64 != 0 {
		t := fromUnixMilli(finished.Int64)
		r.FinishedAt = &t
	}
	return r, nil
}

// unixMilli converts a time to stored unix milliseconds; the zero time
// stores 0. Run rows keep millisecond precision: run durations are visible.
func unixMilli(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

// fromUnixMilli restores a time from stored unix milliseconds; 0 reads back
// as the zero time.
func fromUnixMilli(ms int64) time.Time {
	if ms == 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms)
}

// unixMilliOrZero writes an optional run timestamp; nil stores 0.
func unixMilliOrZero(t *time.Time) int64 {
	if t == nil || t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

// boolInt stores a Go bool as its SQLite 0/1 form.
func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

// unixSecPtr converts an optional time to stored unix seconds; nil and the
// zero time both store NULL.
func unixSecPtr(t *time.Time) any {
	if t == nil || t.IsZero() {
		return nil
	}
	return t.Unix()
}
