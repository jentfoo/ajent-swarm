package store

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// sampleJob returns a valid interval job with caller-tunable fields.
func sampleJob(name string) Job {
	return Job{
		Name:            name,
		Workspace:       "/repo",
		Prompt:          "run the checks",
		ScheduleKind:    ScheduleInterval,
		IntervalSeconds: 60,
		OnMissed:        MissSkip,
		Overlap:         OverlapRun,
		Enabled:         true,
		CreatedAt:       time.Unix(1000, 0),
	}
}

func TestJobs(t *testing.T) {
	t.Parallel()

	t.Run("roundtrip", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()

		next := time.Unix(5000, 0)
		id, err := st.CreateJob(ctx, Job{
			Name:                "nightly",
			Workspace:           "/repo",
			CommandPrefix:       "timeout 300",
			Prompt:              "sweep the logs",
			SpawnMode:           "session",
			SessionTarget:       "nightly",
			Model:               "p/m",
			Permission:          "allow-all",
			Tools:               "builtin:read,builtin:web_search",
			ToolsCustom:         true,
			Enabled:             true,
			ScheduleKind:        ScheduleDaily,
			DailyTime:           "09:00",
			TZ:                  "America/New_York",
			Weekdays:            "mon,fri",
			NextRunAt:           &next,
			OnMissed:            MissFireLate,
			Overlap:             OverlapSkipIfRunning,
			TimeoutMinutes:      45,
			KeepAlive:           true,
			RunWhenIdle:         true,
			IdleMaxDelaySeconds: 3600,
			TriggerCommand:      "git pull --ff-only",
			TriggerOn:           TriggerOnError,
			CreatedAt:           time.Unix(1000, 0),
		})
		require.NoError(t, err)
		assert.Positive(t, id)

		got, err := st.JobByID(ctx, id)
		require.NoError(t, err)
		assert.Equal(t, "nightly", got.Name)
		assert.Equal(t, "/repo", got.Workspace)
		assert.Equal(t, "timeout 300", got.CommandPrefix)
		assert.Equal(t, "sweep the logs", got.Prompt)
		assert.Equal(t, "session", got.SpawnMode)
		assert.Equal(t, "nightly", got.SessionTarget)
		assert.Equal(t, "p/m", got.Model)
		assert.Equal(t, "allow-all", got.Permission)
		assert.Equal(t, "builtin:read,builtin:web_search", got.Tools)
		assert.True(t, got.ToolsCustom)
		assert.True(t, got.Enabled)
		assert.Equal(t, ScheduleDaily, got.ScheduleKind)
		assert.Equal(t, "09:00", got.DailyTime)
		assert.Equal(t, "America/New_York", got.TZ)
		assert.Equal(t, "mon,fri", got.Weekdays)
		require.NotNil(t, got.NextRunAt)
		assert.Equal(t, next, *got.NextRunAt)
		assert.Equal(t, MissFireLate, got.OnMissed)
		assert.Equal(t, OverlapSkipIfRunning, got.Overlap)
		assert.Equal(t, 45, got.TimeoutMinutes)
		assert.True(t, got.KeepAlive)
		assert.True(t, got.RunWhenIdle)
		assert.Equal(t, 3600, got.IdleMaxDelaySeconds)
		assert.Equal(t, "git pull --ff-only", got.TriggerCommand)
		assert.Equal(t, TriggerOnError, got.TriggerOn)
		assert.Equal(t, time.Unix(1000, 0), got.CreatedAt)

		got.Prompt = "updated"
		got.Enabled = false
		got.ToolsCustom = false // a save that turns the flag off clears the list too
		got.Tools = ""
		require.NoError(t, st.UpdateJob(ctx, got))
		again, err := st.JobByID(ctx, id)
		require.NoError(t, err)
		assert.Equal(t, "updated", again.Prompt)
		assert.False(t, again.Enabled)
		assert.False(t, again.ToolsCustom)
		assert.Empty(t, again.Tools)
	})

	t.Run("list_and_lookup", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()

		for _, name := range []string{"b", "a"} {
			_, err := st.CreateJob(ctx, sampleJob(name))
			require.NoError(t, err)
		}

		jobs, err := st.Jobs(ctx)
		require.NoError(t, err)
		require.Len(t, jobs, 2)
		assert.Equal(t, "b", jobs[0].Name) // id order
		assert.Equal(t, "a", jobs[1].Name)

		first := jobs[0]
		got, err := st.JobByID(ctx, first.ID)
		require.NoError(t, err)
		assert.Equal(t, first.Name, got.Name)

		_, err = st.JobByID(ctx, 9999)
		require.ErrorIs(t, err, ErrNotFound)
	})

	t.Run("unique_name", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()

		j, err := st.CreateJob(ctx, sampleJob("b"))
		require.NoError(t, err)

		_, err = st.CreateJob(ctx, sampleJob("a"))
		require.NoError(t, err)

		got, err := st.JobByID(ctx, j)
		require.NoError(t, err)
		got.Name = "a"
		err = st.UpdateJob(ctx, got) // collides with the other row's name
		require.ErrorIs(t, err, ErrConflict)
	})

	t.Run("delete_unlinks_runs", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()

		id, err := st.CreateJob(ctx, sampleJob("gone"))
		require.NoError(t, err)

		jobID := id
		runID, err := st.BeginManualRun(ctx, jobID, false, 4, Run{
			JobID:     &jobID,
			Prompt:    "p",
			Trigger:   TriggerManual,
			Status:    RunOK,
			StartedAt: time.Unix(2000, 0),
		})
		require.NoError(t, err)

		require.NoError(t, st.DeleteJob(ctx, id))
		_, err = st.JobByID(ctx, id)
		require.ErrorIs(t, err, ErrNotFound)

		run, err := st.RunByID(ctx, runID)
		require.NoError(t, err) // history survives the job
		assert.Nil(t, run.JobID)

		err = st.DeleteJob(ctx, id)
		require.ErrorIs(t, err, ErrNotFound)
	})

	t.Run("due_jobs_filter_and_order", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()

		now := time.Unix(10000, 0)
		mk := func(name string, enabled bool, next *time.Time) int64 {
			j := sampleJob(name)
			j.Enabled = enabled
			j.NextRunAt = next
			id, err := st.CreateJob(ctx, j)
			require.NoError(t, err)
			return id
		}
		old := now.Add(-10 * time.Second)
		older := now.Add(-60 * time.Second)
		future := now.Add(time.Minute)

		mk("disabled_due", false, &old)
		mk("future_enabled", true, &future)
		noNext := sampleJob("no_next")
		noNext.NextRunAt = nil
		_, err := st.CreateJob(ctx, noNext)
		require.NoError(t, err)
		mk("later_due", true, &old)
		first := mk("earlier_due", true, &older)

		due, err := st.DueJobs(ctx, now)
		require.NoError(t, err)
		require.Len(t, due, 2) // oldest slot first
		assert.Equal(t, "earlier_due", due[0].Name)
		assert.Equal(t, first, due[0].ID)
		assert.Equal(t, "later_due", due[1].Name)

		early, err := st.EarliestNextRun(ctx)
		require.NoError(t, err)
		require.NotNil(t, early)
		assert.True(t, early.Equal(older))
	})

	t.Run("scheduled_fire_claims_slot", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()

		slot := time.Unix(10000, 0)
		id, err := st.CreateJob(ctx, sampleJob("claim"))
		require.NoError(t, err)
		jobID := id
		slotTime := slot
		j := sampleJob("claim")
		j.ID = jobID
		j.NextRunAt = &slotTime
		require.NoError(t, st.UpdateJob(ctx, j))

		next := slot.Add(time.Minute)
		runID, status, claimed, err := st.StartScheduledFire(ctx, jobID, slot, &next,
			false, 4, Run{JobID: &jobID, Trigger: TriggerSchedule, Status: RunRunning,
				StartedAt: slot})
		require.NoError(t, err)
		require.True(t, claimed)
		assert.Equal(t, RunRunning, status)
		assert.Positive(t, runID)

		// the schedule advanced, so replaying the same slot claims nothing
		_, _, claimed, err = st.StartScheduledFire(ctx, jobID, slot, &next,
			false, 4, Run{JobID: &jobID, Trigger: TriggerSchedule,
				Status: RunRunning, StartedAt: slot})
		require.NoError(t, err)
		assert.False(t, claimed)

		got, err := st.JobByID(ctx, id)
		require.NoError(t, err)
		require.NotNil(t, got.NextRunAt)
		assert.True(t, got.NextRunAt.Equal(next))

		// clearing to NULL (a fired one-shot) claims the old value again
		_, _, claimed, err = st.StartScheduledFire(ctx, jobID, next, nil,
			false, 4, Run{JobID: &jobID, Trigger: TriggerSchedule,
				Status: RunRunning, StartedAt: next})
		require.NoError(t, err)
		require.True(t, claimed)
		got, err = st.JobByID(ctx, id)
		require.NoError(t, err)
		assert.Nil(t, got.NextRunAt)

		runs, err := st.Runs(ctx, jobID, 10)
		require.NoError(t, err)
		require.Len(t, runs, 2)
	})

	t.Run("scheduled_fire_overlap_skips", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()

		slot := time.Unix(10000, 0)
		id, err := st.CreateJob(ctx, sampleJob("overlap"))
		require.NoError(t, err)

		next := slot.Add(time.Minute)
		slotTime := slot
		jobID := id
		j := sampleJob("overlap")
		j.ID = jobID
		j.NextRunAt = &slotTime
		require.NoError(t, st.UpdateJob(ctx, j))

		live := Run{JobID: &jobID, Trigger: TriggerSchedule, Status: RunRunning,
			StartedAt: slot}
		runID, status, claimed, err := st.StartScheduledFire(ctx, jobID, slot, &next,
			false, 4, live)
		require.NoError(t, err)
		require.True(t, claimed)
		assert.Equal(t, RunRunning, status)

		follow := next.Add(time.Minute)
		run2, status, claimed, err := st.StartScheduledFire(ctx, jobID, next,
			&follow, true, 4, live)
		require.NoError(t, err)
		require.True(t, claimed)
		assert.Equal(t, RunSkipped, status)

		skipped, err := st.RunByID(ctx, run2)
		require.NoError(t, err)
		assert.Equal(t, RunSkipped, skipped.Status)
		assert.NotEmpty(t, skipped.Error)

		// once the live run settles, the fire goes through again
		live.ID = runID
		live.Status = RunOK
		fin := time.Unix(11000, 0)
		live.FinishedAt = &fin
		require.NoError(t, st.UpdateRun(ctx, live))

		// a fresh fire starts live: the caller's pre-set status is honored, so
		// reset it instead of reusing the settled row's values
		live.Status = RunRunning
		live.FinishedAt = nil
		run3, status, claimed, err := st.StartScheduledFire(ctx, jobID,
			follow, nil, true, 4, live)
		require.NoError(t, err)
		require.True(t, claimed)
		assert.Equal(t, RunRunning, status)
		assert.Positive(t, run3)
	})

	t.Run("global_run_cap", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()

		slot := time.Unix(10000, 0)
		id, err := st.CreateJob(ctx, sampleJob("capped"))
		require.NoError(t, err)

		slotTime := slot
		jobID := id
		j := sampleJob("capped")
		j.ID = jobID
		j.NextRunAt = &slotTime
		require.NoError(t, st.UpdateJob(ctx, j))

		other := id + 1
		live := Run{JobID: &other, Trigger: TriggerSchedule, Status: RunRunning,
			StartedAt: slot}
		_, _, claimed, err := st.StartScheduledFire(ctx, jobID, slot, nil,
			false, 4, live)
		require.NoError(t, err)
		require.True(t, claimed)

		// one live run at the cap of 1 flips this fire to skipped
		next := slot.Add(time.Minute)
		j.NextRunAt = &next
		require.NoError(t, st.UpdateJob(ctx, j))
		run2, status, claimed, err := st.StartScheduledFire(ctx, jobID, next, nil,
			false, 1, live)
		require.NoError(t, err)
		require.True(t, claimed)
		assert.Equal(t, RunSkipped, status)
		row, err := st.RunByID(ctx, run2)
		require.NoError(t, err)
		assert.Contains(t, row.Error, "global run limit")
	})

	t.Run("manual_run_guards", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()

		id, err := st.CreateJob(ctx, sampleJob("manual"))
		require.NoError(t, err)

		now := time.Unix(10000, 0)
		jobID := id
		run1, err := st.BeginManualRun(ctx, jobID, true, 2, Run{JobID: &jobID,
			Trigger: TriggerManual, Status: RunRunning, StartedAt: now})
		require.NoError(t, err)
		assert.Positive(t, run1)

		_, err = st.BeginManualRun(ctx, jobID, true, 2, Run{JobID: &jobID,
			Trigger: TriggerManual, Status: RunRunning, StartedAt: now})
		require.ErrorIs(t, err, ErrLiveRun) // skip-if-running refuses

		// a second distinct job still fits under the global cap
		id2, err := st.CreateJob(ctx, sampleJob("other"))
		require.NoError(t, err)
		jobID2 := id2
		_, err = st.BeginManualRun(ctx, jobID2, false, 1, Run{JobID: &jobID2,
			Trigger: TriggerManual, Status: RunRunning, StartedAt: now})
		require.ErrorIs(t, err, ErrCapacity)

		// runs do not block manual fires when the policy allows them
		_, err = st.BeginManualRun(ctx, jobID, false, 4, Run{JobID: &jobID,
			Trigger: TriggerManual, Status: RunRunning, StartedAt: now})
		require.NoError(t, err)
	})

	t.Run("fail_interrupted_runs", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()

		id, err := st.CreateJob(ctx, sampleJob("swept"))
		require.NoError(t, err)

		now := time.Unix(10000, 0)
		jobID := id
		mkRun := func(status string) Run {
			runID, err := st.BeginManualRun(ctx, jobID, false, 10, Run{JobID: &jobID,
				Trigger: TriggerSchedule, Status: status, StartedAt: now})
			require.NoError(t, err)
			run, err := st.RunByID(ctx, runID)
			require.NoError(t, err)
			return run
		}
		live := mkRun(RunRunning)
		awaiting := mkRun(RunAwaitingInput)
		done := mkRun(RunOK)

		n, err := st.FailInterruptedRuns(ctx, now.Add(time.Minute), "interrupted by a service restart")
		require.NoError(t, err)
		assert.Equal(t, int64(2), n)

		for runID, want := range map[int64]string{live.ID: RunFailed,
			awaiting.ID: RunFailed, done.ID: RunOK} {
			run, err := st.RunByID(ctx, runID)
			require.NoError(t, err)
			assert.Equal(t, want, run.Status)
			if want == RunFailed {
				assert.Contains(t, run.Error, "interrupted by a service restart")
				require.NotNil(t, run.FinishedAt)
			}
		}
	})

	t.Run("prune_runs_age_and_count", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()

		id, err := st.CreateJob(ctx, sampleJob("pruned"))
		require.NoError(t, err)
		jobID := id

		base := time.Unix(10000, 0)
		for i := range 5 {
			runID, err := st.BeginManualRun(ctx, jobID, false, 10, Run{JobID: &jobID,
				Trigger: TriggerSchedule, Status: RunOK,
				StartedAt: base.Add(time.Duration(i) * time.Minute)})
			require.NoError(t, err)
			_ = runID
		}

		// the age cutoff keeps the row that starts exactly at it
		n, err := st.PruneRuns(ctx, base.Add(2*time.Minute), 0)
		require.NoError(t, err)
		assert.Equal(t, int64(2), n) // rows starting before the cutoff

		// a count cap above the remaining rows prunes nothing
		n, err = st.PruneRuns(ctx, time.Unix(0, 0), 3)
		require.NoError(t, err)
		assert.Zero(t, n)

		// the count cap trims from the oldest side
		n, err = st.PruneRuns(ctx, time.Unix(0, 0), 2)
		require.NoError(t, err)
		assert.Equal(t, int64(1), n)

		runs, err := st.Runs(ctx, jobID, 10)
		require.NoError(t, err)
		require.Len(t, runs, 2)
		assert.Greater(t, runs[0].StartedAt, runs[1].StartedAt) // newest first
	})

	t.Run("run_roundtrip", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()

		id, err := st.CreateJob(ctx, sampleJob("runs"))
		require.NoError(t, err)

		started := time.Unix(5000, 0)
		jobID := id
		runID, err := st.BeginManualRun(ctx, jobID, false, 4, Run{JobID: &jobID,
			Prompt: "do it", Trigger: TriggerSchedule, Status: RunRunning,
			StartedAt: started})
		require.NoError(t, err)

		run, err := st.RunByID(ctx, runID)
		require.NoError(t, err)
		assert.Equal(t, jobID, *run.JobID)
		assert.Empty(t, run.SessionID)
		assert.Equal(t, "do it", run.Prompt)
		assert.Equal(t, TriggerSchedule, run.Trigger)
		assert.Equal(t, RunRunning, run.Status)
		assert.True(t, run.StartedAt.Equal(started))
		assert.Nil(t, run.FinishedAt)

		run.SessionID = "01SESS"
		fin := time.Unix(5100, 0)
		run.FinishedAt = &fin
		run.Status = RunOK
		require.NoError(t, st.UpdateRun(ctx, run))

		got, err := st.RunByID(ctx, runID)
		require.NoError(t, err)
		assert.Equal(t, "01SESS", got.SessionID)
		require.NotNil(t, got.FinishedAt)
		assert.True(t, got.FinishedAt.Equal(fin))
		assert.Equal(t, RunOK, got.Status)

		// the zero finished time writes back as NULL
		run.Status = RunRunning
		run.FinishedAt = nil
		require.NoError(t, st.UpdateRun(ctx, run))
		got, err = st.RunByID(ctx, runID)
		require.NoError(t, err)
		assert.Nil(t, got.FinishedAt)
	})
}
