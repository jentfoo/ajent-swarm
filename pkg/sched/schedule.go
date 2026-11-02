// Package sched runs ajent-swarm's persistent scheduler: one trigger
// goroutine fires due jobs from the SQLite store, each fire executes as a run
// that launches (or resumes) a serve session through fleet, submits its
// prompt and watches it settle under a bounded timeout.
package sched

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	"github.com/jentfoo/ajent-swarm/pkg/store"
	"github.com/jentfoo/ajent/pkg/session"
)

// Validation bounds.
const (
	maxNameLen     = 200
	maxPrefixLen   = 2000
	maxIntervalSec = 366 * 24 * 3600 // one leap year of seconds
)

// Schedule is a job's resolved fire cadence. Kind selects among the store's
// schedule kinds; TZ resolves as an IANA zone name, empty for server local.
type Schedule struct {
	Kind      string // store.ScheduleOnce, ScheduleInterval or ScheduleDaily
	Interval  time.Duration
	DailyTime string // daily jobs: HH:MM wall clock in Loc
	Loc       *time.Location
}

// scheduleOf reads the cadence fields off one job row.
func scheduleOf(j store.Job) (Schedule, error) {
	switch j.ScheduleKind {
	case store.ScheduleInterval:
		return Schedule{Kind: j.ScheduleKind,
			Interval: time.Duration(j.IntervalSeconds) * time.Second}, nil
	case store.ScheduleDaily:
		loc, err := locationOf(j.TZ)
		if err != nil {
			return Schedule{}, err
		}
		return Schedule{Kind: j.ScheduleKind, DailyTime: j.DailyTime, Loc: loc}, nil
	case store.ScheduleOnce:
		return Schedule{Kind: j.ScheduleKind}, nil
	default:
		return Schedule{}, fmt.Errorf("unknown schedule kind %q", j.ScheduleKind)
	}
}

// locationOf resolves an IANA zone name; empty means server local time.
func locationOf(name string) (*time.Location, error) {
	if strings.TrimSpace(name) == "" {
		return time.Local, nil
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		return nil, fmt.Errorf("unknown timezone %q", name)
	}
	return loc, nil
}

// NextAfter returns the first scheduled slot strictly after from. Interval
// slots stay anchored on the job's creation, so catch-up is arithmetic and a
// long downtime never storms; daily slots evaluate in the job's own zone per
// fire (local-wall semantics across DST edges).
func (s Schedule) NextAfter(created time.Time, from time.Time) (time.Time, error) {
	switch s.Kind {
	case store.ScheduleInterval:
		if s.Interval <= 0 {
			return time.Time{}, errors.New("interval must be positive")
		}
		steps := int(from.Sub(created)/s.Interval) + 1
		return created.Add(time.Duration(steps) * s.Interval), nil

	case store.ScheduleDaily:
		hh, mm, err := parseDailyTime(s.DailyTime)
		if err != nil {
			return time.Time{}, err
		}
		local := from.In(s.Loc)
		y, m, d := local.Date()
		next := time.Date(y, m, d, hh, mm, 0, 0, s.Loc)
		if !next.After(from) { // today's wall time passed: fire tomorrow
			y2, m2, d2 := local.AddDate(0, 0, 1).Date()
			next = time.Date(y2, m2, d2, hh, mm, 0, 0, s.Loc)
		}
		return next, nil

	default:
		return time.Time{}, fmt.Errorf("schedule %q has no recurring slots", s.Kind)
	}
}

// parseDailyTime reads an HH:MM wall clock in 24-hour form.
func parseDailyTime(s string) (hour, minute int, err error) {
	hhmm := strings.SplitN(strings.TrimSpace(s), ":", 2)
	if len(hhmm) != 2 {
		return 0, 0, fmt.Errorf("daily time %q must be HH:MM", s)
	}
	hour, err = strconv.Atoi(hhmm[0])
	if err != nil || hour < 0 || hour > 23 {
		return 0, 0, fmt.Errorf("daily time %q must be HH:MM", s)
	}
	minute, err = strconv.Atoi(hhmm[1])
	if err != nil || minute < 0 || minute > 59 {
		return 0, 0, fmt.Errorf("daily time %q must be HH:MM", s)
	}
	return hour, minute, nil
}

// InitialNext computes the first fire at or after from for a freshly created,
// re-enabled or rescheduled job. Once jobs keep their explicit slot.
func InitialNext(j store.Job, from time.Time) (*time.Time, error) {
	if j.ScheduleKind == store.ScheduleOnce {
		return j.NextRunAt, nil
	}
	sched, err := scheduleOf(j)
	if err != nil {
		return nil, err
	}
	next, err := sched.NextAfter(j.CreatedAt, from)
	if err != nil {
		return nil, err
	}
	return &next, nil
}

// CheckWorkspace validates one workspace path the way job validation and the
// editor's preview both do: it must exist and be a directory.
func CheckWorkspace(path string) error {
	fi, err := os.Stat(path)
	switch {
	case err == nil && !fi.IsDir():
		return fmt.Errorf("workspace %s is not a directory", path)
	case err != nil:
		return fmt.Errorf("workspace %s: %w", path, err)
	}
	return nil
}

// PreviewTimes returns up to count scheduled fires strictly after from,
// evaluated with the trigger loop's own arithmetic: interval slots stay
// anchored on the job's creation (a zero CreatedAt anchors on from, matching
// what a save would store) and daily times resolve in the job's zone per fire.
// Once jobs answer their single stored slot.
func PreviewTimes(j store.Job, from time.Time, count int) ([]time.Time, error) {
	if j.ScheduleKind == store.ScheduleOnce {
		if j.NextRunAt == nil || j.NextRunAt.IsZero() {
			return nil, errors.New("a once schedule requires next_run_at")
		}
		return []time.Time{*j.NextRunAt}, nil
	}
	sched, err := scheduleOf(j)
	if err != nil {
		return nil, err
	}
	created := j.CreatedAt
	if created.IsZero() {
		created = from
	}
	out := make([]time.Time, 0, max(count, 0))
	prev := from
	for range count {
		next, err := sched.NextAfter(created, prev)
		if err != nil {
			return nil, err
		}
		out = append(out, next)
		prev = next
	}
	return out, nil
}

// ValidateJob normalizes and validates one job's fields. It mirrors the
// launch path's flag rules so a stored job always spawns cleanly; it reports
// the first problem found.
func ValidateJob(j *store.Job) error {
	j.Name = strings.TrimSpace(j.Name)
	if j.Name == "" {
		return errors.New("name is required")
	}
	if len(j.Name) > maxNameLen {
		return fmt.Errorf("name must be at most %d characters", maxNameLen)
	}
	j.Workspace = strings.TrimSpace(j.Workspace)
	if j.Workspace == "" {
		return errors.New("workspace is required")
	}
	if err := CheckWorkspace(j.Workspace); err != nil {
		return err
	}

	j.SpawnMode = strings.TrimSpace(j.SpawnMode)
	if j.SpawnMode == "" {
		j.SpawnMode = string(fleet.LaunchNew)
	}
	if !fleet.ValidLaunchMode(j.SpawnMode) {
		return fmt.Errorf("unknown spawn mode %q", j.SpawnMode)
	}
	switch fleet.LaunchMode(j.SpawnMode) {
	case fleet.LaunchResume:
		if strings.TrimSpace(j.SessionTarget) == "" {
			return errors.New("spawn mode resume needs a session target")
		}
	case fleet.LaunchSession:
		if _, err := session.ValidateName(j.SessionTarget); err != nil {
			return err
		}
	}
	j.SessionTarget = strings.TrimSpace(j.SessionTarget)
	j.Model = strings.TrimSpace(j.Model)
	if !fleet.ValidPermission(j.Permission) {
		return fmt.Errorf("unknown permission %q", j.Permission)
	}

	switch j.OnMissed {
	case "":
		j.OnMissed = store.MissSkip
	case store.MissSkip, store.MissFireLate:
	default:
		return fmt.Errorf("unknown on_missed policy %q", j.OnMissed)
	}
	switch j.Overlap {
	case "":
		j.Overlap = store.OverlapRun
	case store.OverlapRun, store.OverlapSkipIfRunning:
	default:
		return fmt.Errorf("unknown overlap policy %q", j.Overlap)
	}
	if j.TimeoutMinutes < 0 {
		return errors.New("timeout_minutes must not be negative")
	}
	if len(j.CommandPrefix) > maxPrefixLen {
		return fmt.Errorf("command_prefix must be at most %d characters", maxPrefixLen)
	}

	switch j.ScheduleKind {
	case store.ScheduleOnce:
		if j.NextRunAt == nil || j.NextRunAt.IsZero() {
			return errors.New("a once schedule requires next_run_at")
		}
	case store.ScheduleInterval:
		if j.IntervalSeconds <= 0 {
			return errors.New("interval_seconds must be positive")
		}
		if j.IntervalSeconds > maxIntervalSec {
			return errors.New("interval_seconds is too large")
		}
	case store.ScheduleDaily:
		if _, _, err := parseDailyTime(j.DailyTime); err != nil {
			return err
		}
		j.TZ = strings.TrimSpace(j.TZ)
		if _, err := locationOf(j.TZ); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unknown schedule kind %q", j.ScheduleKind)
	}
	return nil
}
