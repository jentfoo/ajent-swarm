package sched

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jentfoo/ajent-swarm/pkg/store"
)

// Scheduler defaults.
const (
	maxTick         = 10 * time.Second // never sleep past this, even with nothing due
	missedGrace     = 2 * time.Minute  // a slot older than this counts as missed
	sweepEvery      = time.Hour        // retention cadence after the startup sweep
	defaultRunLimit = 4                // global concurrent runs
	interruptedNote = "interrupted by a service restart"
)

// Options tunes the scheduler, zero values take production defaults.
type Options struct {
	Log    *slog.Logger
	Store  *store.Store
	Runner Runner

	MaxConcurrent int           // global cap of live runs
	Tick          time.Duration // trigger loop's maximum sleep between checks
	MissedGrace   time.Duration // slots older than this follow the missed policy
	RetentionDays int           // run rows and child logs older than this prune away, 0 keeps forever
	RetentionMax  int           // run row count cap, 0 unbounded

	ChildrenDir string // child log directory for retention sweeps, may be empty
}

// withDefaults resolves the production fallbacks.
func (o *Options) withDefaults() {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.MaxConcurrent <= 0 {
		o.MaxConcurrent = defaultRunLimit
	}
	if o.Tick <= 0 {
		o.Tick = maxTick
	}
	if o.MissedGrace <= 0 {
		o.MissedGrace = missedGrace
	}
}

// Scheduler triggers jobs and drives their runs to completion.
type Scheduler struct {
	opts   Options
	log    *slog.Logger
	store  *store.Store
	runner Runner

	ctx      context.Context // run bookkeeping detaches from shutdown cancellation
	baseCtx  context.Context
	cancel   context.CancelFunc
	nudge    chan struct{}
	wg       sync.WaitGroup
	stopOnce sync.Once
}

// New builds a scheduler over one store and fleet runner, Start begins the
// trigger loop.
func New(opts Options) *Scheduler {
	opts.withDefaults()
	s := &Scheduler{
		opts:   opts,
		log:    opts.Log,
		store:  opts.Store,
		runner: opts.Runner,
		nudge:  make(chan struct{}, 1),
	}
	// watchers and manual fires may run before Start, Start swaps in the
	// service's own context
	s.baseCtx, s.cancel = context.WithCancel(context.Background())
	s.ctx = context.WithoutCancel(s.baseCtx)
	return s
}

// Start sweeps interrupted runs and begins the trigger loop until Stop. It
// must precede concurrent Stop calls.
func (s *Scheduler) Start(ctx context.Context) {
	s.cancel()                                // retire the placeholder contexts New installed
	bookkeeping := context.WithoutCancel(ctx) // run records outlive every caller
	s.baseCtx, s.cancel = context.WithCancel(ctx)
	s.ctx = bookkeeping

	if n, err := s.store.FailInterruptedRuns(bookkeeping, time.Now(), interruptedNote); err != nil {
		s.log.Warn("interrupted-run sweep failed", "err", err)
	} else if n > 0 {
		s.log.Info("marked runs interrupted by restart", "count", n)
	}

	// a crash mid-run leaves queued rows with no slot and no watcher to finish
	// them, the sweep above already settled their runs
	if n, err := s.store.PruneAbandonedQueued(bookkeeping); err != nil {
		s.log.Warn("queued-job sweep failed", "err", err)
	} else if n > 0 {
		s.log.Info("removed queued jobs abandoned by a restart", "count", n)
	}

	s.wg.Add(1)
	go func() { //nolint:contextcheck // loop binds ctx at Start, bookkeeping detaches
		defer s.wg.Done()
		s.loop()
	}()
}

// Stop ends the trigger loop and every run watcher. Live run rows stay as
// they are: the next Start marks them failed with the interrupted reason.
func (s *Scheduler) Stop() {
	s.stopOnce.Do(func() {
		s.cancel()
		s.wg.Wait()
	})
}

// Nudge wakes the trigger loop at once, so job edits take effect without
// waiting out the tick.
func (s *Scheduler) Nudge() {
	select {
	case s.nudge <- struct{}{}:
	default:
	}
}

// loop is the single trigger goroutine: sleep until the earliest scheduled
// fire or a nudge, clamped to a short maximum tick, then claim every due job.
func (s *Scheduler) loop() {
	// one retention pass at startup keeps long-gone installs bounded
	nextSweep := s.sweep()
	// idleHeld tracks whether the last pass left a due job waiting for a quiet
	// fleet: such a job keeps its past slot, so the earliest-slot hint would
	// collapse every later wait to zero and spin the loop for the whole hold
	var idleHeld bool
	for s.baseCtx.Err() == nil {
		select {
		case <-s.baseCtx.Done():
			return
		case <-s.nudge:
		case <-time.After(s.nextWait(idleHeld)):
		}

		now := time.Now()
		due, err := s.store.DueJobs(s.ctx, now)
		if err != nil {
			s.log.Warn("reading due jobs failed", "err", err)
			continue
		}
		idleHeld = false
		for _, j := range due {
			if s.fireDue(j, now) {
				idleHeld = true
			}
		}

		if !now.Before(nextSweep) {
			nextSweep = s.sweep()
		}
	}
}

// nextWait picks the loop's next sleep: the earliest scheduled fire wins,
// clamped to the tick. A pass that held jobs for a quiet fleet leaves their
// slots in the past, so the fleet's quiet moment bounds the wait instead and
// the loop never spins on a slot it already declined to fire.
func (s *Scheduler) nextWait(idleHeld bool) time.Duration {
	if idleHeld {
		quiet := time.Until(s.runner.LastBusyAt().Add(idleWindow))
		return max(min(s.opts.Tick, quiet), 0)
	}
	wait := s.opts.Tick
	if earliest, err := s.store.EarliestNextRun(s.ctx); err != nil {
		s.log.Warn("reading the schedule failed", "err", err)
	} else if earliest != nil {
		if d := time.Until(*earliest); d < wait {
			wait = max(d, 0)
		}
	}
	return wait
}

// fireDue claims one due slot: run-when-idle jobs wait for a quiet fleet
// (skipping once their delay cap passes), missed jobs follow their on_missed
// policy, and the schedule always advances before any launch. A claimed run
// then executes asynchronously, a skipped or refused slot only records its
// row. It reports whether the job stayed due waiting for an idle fleet.
func (s *Scheduler) fireDue(j store.Job, now time.Time) bool {
	slot := *j.NextRunAt

	lastBusy := s.runner.LastBusyAt()
	if j.RunWhenIdle && !lastBusy.IsZero() && now.Sub(lastBusy) < idleWindow {
		maxDelay := time.Duration(j.IdleMaxDelaySeconds) * time.Second
		waited := now.Sub(slot)
		if maxDelay <= 0 || waited < maxDelay {
			return true // stay due: a later tick fires it once the fleet quiets down
		}
		s.skipDue(j, slot, "skipped: still busy after waiting "+
			formatDelay(waited)+" for an idle fleet")
		return false
	}
	// one quiet moment serves one release: a lost claim re-arms behind the
	// winner instead of firing into the same idle point
	if j.RunWhenIdle && !s.runner.ClaimRelease(idleWindow) {
		return true // stay due, the winner's release holds the fleet for us too
	}

	run := s.baseRun(j, store.TriggerSchedule, now)
	late := !j.RunWhenIdle && // an idle wait delays by design, never late
		now.Sub(slot) > s.opts.MissedGrace
	if late && (j.ScheduleKind == store.ScheduleOnce || j.OnMissed == store.MissSkip) {
		run.Status = store.RunSkipped // the slot is beyond its grace window
		if j.ScheduleKind == store.ScheduleOnce {
			run.Error = "skipped: one-shot missed its slot at " + slot.Format(time.RFC3339)
		} else {
			run.Error = "skipped: slot at " + slot.Format(time.RFC3339) +
				" was missed while the service was away"
		}
	}

	id, final, claimed := s.claimFire(j, slot, now, run)
	if !claimed { // advanced or deleted elsewhere, nothing to do
		return false
	}
	run.ID = id
	run.Status = final

	switch final {
	case store.RunSkipped:
		s.log.Info("run skipped", "job", j.Name, "reason", run.Error)
		if j.Queued { // nothing follows a skipped slot: the wait is over
			s.dropQueuedJob(j.ID)
		}
	default:
		s.log.Info("firing job", "job", j.Name,
			"late", late && j.OnMissed == store.MissFireLate)
		s.wg.Add(1) // claimed before the goroutine starts, so Stop never races it
		go s.execute(run, j)
	}
	return false
}

// skipDue claims one due slot only to record a skipped run with the reason,
// advancing the schedule like any other claim so restarts never re-decide it.
func (s *Scheduler) skipDue(j store.Job, slot time.Time, reason string) {
	now := time.Now()
	run := s.baseRun(j, store.TriggerSchedule, now)
	run.Status = store.RunSkipped
	run.Error = reason
	id, final, claimed := s.claimFire(j, slot, now, run)
	if claimed && final == store.RunSkipped {
		s.log.Info("run skipped", "job", j.Name, "reason", reason,
			"run", id)
	}
}

// claimFire advances the slot and records one scheduled run, claiming it so
// restarts never double-fire. It reports the claimed run's id and final
// status, claimed is false when the schedule is broken or another pass
// advanced or deleted the slot first.
func (s *Scheduler) claimFire(j store.Job, slot, now time.Time, run store.Run) (int64, string, bool) {
	var newNext *time.Time // nil clears the schedule (a fired one-shot)
	if j.ScheduleKind != store.ScheduleOnce {
		next, err := InitialNext(j, now)
		if err != nil {
			s.log.Error("job schedule is broken", "job", j.Name, "err", err)
			return 0, "", false
		}
		newNext = next
	}
	id, final, claimed, err := s.store.StartScheduledFire(s.ctx, j.ID, slot, newNext,
		j.Overlap == store.OverlapSkipIfRunning, s.opts.MaxConcurrent, run)
	if err != nil {
		s.log.Warn("claiming a fire failed", "job", j.Name, "err", err)
		return 0, "", false
	}
	return id, final, claimed
}

// formatDelay renders a wait for skip reasons: 90s, 45m, 2h.
func formatDelay(d time.Duration) string {
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	default:
		return fmt.Sprintf("%dh", int(d.Hours()+0.5))
	}
}

// baseRun seeds the run row every fire starts from.
func (s *Scheduler) baseRun(j store.Job, trigger string, now time.Time) store.Run {
	jobID := j.ID
	return store.Run{
		JobID:     &jobID,
		Prompt:    j.Prompt,
		Trigger:   trigger,
		Status:    store.RunRunning,
		StartedAt: now,
	}
}

// FireNow manually fires one job regardless of its schedule or enabled state.
// The overlap policy and the global run limit still apply. The returned row
// is what was recorded, execution continues in the background.
func (s *Scheduler) FireNow(ctx context.Context, jobID int64) (store.Run, error) {
	j, err := s.store.JobByID(ctx, jobID)
	if err != nil {
		return store.Run{}, err
	}

	run := s.baseRun(j, store.TriggerManual, time.Now())
	id, err := s.store.BeginManualRun(ctx, j.ID,
		j.Overlap == store.OverlapSkipIfRunning, s.opts.MaxConcurrent, run)
	if err != nil {
		return store.Run{}, err
	}
	run.ID = id

	s.log.Info("manual fire", "job", j.Name)
	s.wg.Add(1)
	go s.execute(run, j) //nolint:contextcheck // runs outlive the caller's ctx
	return run, nil
}

// Job and run reads and writes for the API layer, the scheduler owns no
// cached job state, so these pass straight through to the store.

// Jobs lists every stored job.
func (s *Scheduler) Jobs(ctx context.Context) ([]store.Job, error) { return s.store.Jobs(ctx) }

// JobByID returns one stored job by id.
func (s *Scheduler) JobByID(ctx context.Context, id int64) (store.Job, error) {
	return s.store.JobByID(ctx, id)
}

// CreateJob stores one new job and wakes the trigger loop, so an immediately
// due fire does not wait out the tick.
func (s *Scheduler) CreateJob(ctx context.Context, j store.Job) (int64, error) {
	id, err := s.store.CreateJob(ctx, j)
	if err != nil {
		return 0, err
	}
	s.Nudge()
	return id, nil
}

// UpdateJob writes one job's fields and wakes the trigger loop.
func (s *Scheduler) UpdateJob(ctx context.Context, j store.Job) error {
	if err := s.store.UpdateJob(ctx, j); err != nil {
		return err
	}
	s.Nudge()
	return nil
}

// DeleteJob removes one job, unlinks its runs and wakes the trigger loop.
func (s *Scheduler) DeleteJob(ctx context.Context, id int64) error {
	if err := s.store.DeleteJob(ctx, id); err != nil {
		return err
	}
	s.Nudge()
	return nil
}

// Runs lists run history newest first, optionally one job's only.
func (s *Scheduler) Runs(ctx context.Context, jobID int64, limit int) ([]store.Run, error) {
	return s.store.Runs(ctx, jobID, limit)
}

// sweep prunes run rows and child logs by age and count. Returns when the
// next sweep is due.
func (s *Scheduler) sweep() time.Time {
	if s.opts.RetentionDays > 0 || s.opts.RetentionMax > 0 {
		var cutoff time.Time
		if s.opts.RetentionDays > 0 {
			cutoff = time.Now().AddDate(0, 0, -s.opts.RetentionDays)
		}
		n, err := s.store.PruneRuns(s.ctx, cutoff, s.opts.RetentionMax)
		if err != nil {
			s.log.Warn("run retention sweep failed", "err", err)
		} else if n > 0 {
			s.log.Info("pruned run history", "count", n)
		}
		if s.opts.ChildrenDir != "" && !cutoff.IsZero() {
			pruneChildLogs(s.opts.ChildrenDir, cutoff, s.log)
		}
	}
	return time.Now().Add(sweepEvery)
}
