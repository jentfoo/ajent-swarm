// Package sched runs ajent-swarm's persistent scheduler: one trigger
// goroutine fires due jobs from the SQLite store, each fire executes as a run
// that launches (or resumes) a serve session through fleet, submits its
// prompt and watches it settle under a bounded timeout.
package sched

import (
	"errors"
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	"github.com/jentfoo/ajent-swarm/pkg/store"
	"github.com/jentfoo/ajent/pkg/session"
)

// Validation bounds.
const (
	maxNameLen      = 200
	maxPrefixLen    = 2000
	maxIntervalSec  = 366 * 24 * 3600 // one leap year of seconds
	maxIdleDelaySec = 30 * 24 * 3600  // a month of waiting, then skip
)

// schedule is a job's resolved fire cadence. Kind selects among the store's
// schedule kinds, TZ resolves as an IANA zone name, empty for server local.
// Weekdays restricts recurring slots to chosen days, empty meaning every day.
type schedule struct {
	Kind      string // store.ScheduleOnce, ScheduleInterval or ScheduleDaily
	Interval  time.Duration
	DailyTime string // daily jobs: HH:MM wall clock in Loc
	Loc       *time.Location
	Weekdays  []time.Weekday
}

// scheduleOf reads the cadence fields off one job row.
func scheduleOf(j store.Job) (schedule, error) {
	weekdays, err := parseWeekdays(j.Weekdays)
	if err != nil {
		return schedule{}, err
	}
	switch j.ScheduleKind {
	case store.ScheduleInterval:
		return schedule{Kind: j.ScheduleKind,
			Interval: time.Duration(j.IntervalSeconds) * time.Second, Loc: time.Local,
			Weekdays: weekdays}, nil
	case store.ScheduleDaily:
		loc, err := locationOf(j.TZ)
		if err != nil {
			return schedule{}, err
		}
		return schedule{Kind: j.ScheduleKind, DailyTime: j.DailyTime, Loc: loc,
			Weekdays: weekdays}, nil
	case store.ScheduleOnce:
		return schedule{Kind: j.ScheduleKind}, nil
	default:
		return schedule{}, fmt.Errorf("unknown schedule kind %q", j.ScheduleKind)
	}
}

// locationOf resolves an IANA zone name, empty means server local time.
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
// long downtime never storms, daily slots evaluate in the job's own zone per
// fire (local-wall semantics across DST edges). A weekday restriction skips
// slots landing on unchosen days.
func (s schedule) NextAfter(created time.Time, from time.Time) (time.Time, error) {
	switch s.Kind {
	case store.ScheduleInterval:
		if s.Interval <= 0 {
			return time.Time{}, errors.New("interval must be positive")
		}
		steps := int(from.Sub(created)/s.Interval) + 1
		// a week plus a day of slots always probes every weekday, so the bound
		// turns an unreachable restriction into an error instead of a spin
		for range max(16, (8*24*3600+int(s.Interval.Seconds())-1)/int(s.Interval.Seconds())) {
			next := created.Add(time.Duration(steps) * s.Interval)
			if len(s.Weekdays) == 0 || slices.Contains(s.Weekdays, next.In(s.Loc).Weekday()) {
				return next, nil
			}
			steps++
		}
		return time.Time{}, errors.New("weekday restriction never reaches a slot")

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
		for range 8 { // a week of days always covers every chosen weekday
			if len(s.Weekdays) == 0 || slices.Contains(s.Weekdays, next.Weekday()) {
				return next, nil
			}
			next = next.AddDate(0, 0, 1)
		}
		return time.Time{}, errors.New("weekday restriction never reaches a slot")

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

// weekdayName pairs the stored tokens with their Go weekdays.
type weekdayName struct {
	token string
	day   time.Weekday
}

// weekdayNames maps the stored tokens onto Go weekdays, order is display order.
var weekdayNames = []weekdayName{
	{"sun", time.Sunday}, {"mon", time.Monday}, {"tue", time.Tuesday},
	{"wed", time.Wednesday}, {"thu", time.Thursday}, {"fri", time.Friday},
	{"sat", time.Saturday},
}

// parseWeekdays reads a job's weekday restriction: a comma list of sun..sat,
// case insensitive, each at most once. Empty or whitespace means every day.
func parseWeekdays(s string) ([]time.Weekday, error) {
	if strings.TrimSpace(s) == "" {
		return nil, nil
	}
	parts := strings.Split(s, ",")
	out := make([]time.Weekday, 0, len(parts))
	seen := make(map[time.Weekday]struct{}, len(parts))
	for _, raw := range parts {
		token := strings.ToLower(strings.TrimSpace(raw))
		i := slices.IndexFunc(weekdayNames, func(w weekdayName) bool { return w.token == token })
		if i < 0 {
			return nil, fmt.Errorf("unknown weekday %q (use sun..sat)", raw)
		}
		day := weekdayNames[i].day
		if _, dup := seen[day]; dup {
			return nil, fmt.Errorf("weekday %q listed twice", token)
		}
		seen[day] = struct{}{}
		out = append(out, day)
	}
	return out, nil
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

// onceReArmOffset is how far out a slotless once job re-arms when enabled:
// one fixed day keeps the list toggle a single predictable click.
const onceReArmOffset = 24 * time.Hour

// ReArmOnce returns the fire slot a slotless once job takes when enabled.
func ReArmOnce(from time.Time) time.Time {
	return from.Add(onceReArmOffset)
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
// launch path's flag rules so a stored job always spawns cleanly, it reports
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
	if j.Queued {
		normalizeQueued(j)
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

	// a custom tool set is the whole enabled list at launch, the flag off
	// means "session default, do not touch the tool set"
	if !j.ToolsCustom {
		j.Tools = ""
	} else {
		j.Tools = strings.Join(parseToolList(j.Tools), ",")
	}
	if len(j.Tools) > maxPrefixLen {
		return fmt.Errorf("tools must be at most %d characters", maxPrefixLen)
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
		// the slot matters only while armed: firing and disabling both clear
		// it, so the requirement tracks the row's resulting enabled state
		if j.Enabled && (j.NextRunAt == nil || j.NextRunAt.IsZero()) {
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

	// weekdays only restrict recurring kinds, a once job keeps its slot as-is
	if j.ScheduleKind != store.ScheduleOnce {
		weekdays, err := parseWeekdays(j.Weekdays)
		if err != nil {
			return err
		}
		j.Weekdays = weekdaysToken(weekdays) // normalized token order
	}

	if j.IdleMaxDelaySeconds < 0 || j.IdleMaxDelaySeconds > maxIdleDelaySec {
		return fmt.Errorf("idle_max_delay_seconds must be between 0 and %d", maxIdleDelaySec)
	}
	j.TriggerCommand = strings.TrimSpace(j.TriggerCommand)
	if len(j.TriggerCommand) > maxPrefixLen {
		return fmt.Errorf("trigger_command must be at most %d characters", maxPrefixLen)
	}
	switch j.TriggerOn {
	case "":
		j.TriggerOn = store.TriggerOnSuccess
	case store.TriggerOnSuccess, store.TriggerOnError:
	default:
		return fmt.Errorf("unknown trigger_on policy %q", j.TriggerOn)
	}
	return nil
}

// normalizeQueued pins the stored shape a queued row must keep: a once slot
// spawning a new session that waits for an idle fleet without a skip cap and
// leaves that session open. Edits round trip through ValidateJob, so these
// fields cannot drift while the row waits.
func normalizeQueued(j *store.Job) {
	j.ScheduleKind = store.ScheduleOnce
	j.SpawnMode = string(fleet.LaunchNew)
	j.SessionTarget = ""
	j.IntervalSeconds = 0
	j.DailyTime = ""
	j.TZ = ""
	j.Weekdays = ""
	j.RunWhenIdle = true
	j.IdleMaxDelaySeconds = 0
	j.KeepAlive = true
}

// weekdaysToken renders a weekday set back into its stored comma form,
// normalized to the canonical sun..sat order.
func weekdaysToken(weekdays []time.Weekday) string {
	if len(weekdays) == 0 {
		return ""
	}
	names := make([]string, 0, len(weekdays))
	for _, name := range weekdayNames {
		if slices.Contains(weekdays, name.day) {
			names = append(names, name.token)
		}
	}
	return strings.Join(names, ",")
}

// parseToolList reads a job's tool comma list onto names: tokens trimmed,
// empties dropped and duplicates collapsed into canonical name order. An empty
// or blank list parses as an intentional tool-less set.
func parseToolList(s string) []string {
	parts := strings.Split(s, ",")
	names := make([]string, 0, len(parts))
	for _, raw := range parts {
		if name := strings.TrimSpace(raw); name != "" {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	return slices.Compact(names)
}
