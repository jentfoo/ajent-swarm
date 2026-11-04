package sched

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	"github.com/jentfoo/ajent-swarm/pkg/store"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// fakeRunner scripts the fleet surface: launches return a fixed session,
// submits may fail before succeeding, and tests push stream frames by hand.
type fakeRunner struct {
	mu        sync.Mutex
	launches  []fleet.LaunchRequest
	submits   []ctl.SubmitParams
	toolsSets [][]string // names per ToolsSet call, in order
	ops       []string   // verb log across calls: "tools", "submit"
	stopped   []string
	subscribe int // subscribe calls the runner served

	launchErr   error         // Launch fails with this when set
	sessionID   string        // session id Launch returns
	submitFailN int           // the first N submits fail as unavailable
	toolsSetErr error         // ToolsSet fails with this when set
	blockLaunch chan struct{} // set: Launch blocks until closed, per call
	deliver     func([]byte)  // deliverer of the latest subscription
	onDrop      func()
	busyAt      time.Time // what LastBusyAt reports; zero means quiet
}

// LastBusyAt answers with the scripted activity moment.
func (f *fakeRunner) LastBusyAt() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.busyAt
}

func newFakeRunner() *fakeRunner {
	return &fakeRunner{sessionID: "01RUNFAKESESSION00"}
}

func (f *fakeRunner) Launch(_ context.Context, req fleet.LaunchRequest) (fleet.LaunchResult, error) {
	f.mu.Lock()
	f.launches = append(f.launches, req)
	gate := f.blockLaunch
	f.mu.Unlock()

	if gate != nil {
		select {
		case <-gate:
		case <-time.After(5 * time.Second):
		}
	}
	if f.launchErr != nil {
		return fleet.LaunchResult{}, f.launchErr
	}
	return fleet.LaunchResult{SessionID: f.sessionID}, nil
}

func (f *fakeRunner) Submit(_ context.Context, _ string, params ctl.SubmitParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	if n := len(f.submits); n < f.submitFailN {
		f.submits = append(f.submits, params)
		return ctl.Errf(ctl.CodeUnavailable, "session is still starting")
	}
	f.submits = append(f.submits, params)
	f.ops = append(f.ops, "submit")
	f.deliverToWatcher()
	return nil
}

// ToolsSet records the requested set; toolsSetErr scripts a refusal.
func (f *fakeRunner) ToolsSet(_ context.Context, _ string,
	names []string) (ctl.ToolsSetResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.toolsSets = append(f.toolsSets, slices.Clone(names))
	f.ops = append(f.ops, "tools")
	return ctl.ToolsSetResult{}, f.toolsSetErr
}

// deliverToWatcher plays the landing sequence a real ajent emits after a
// submit: the committed entry carrying our pendingId, then idle.
func (f *fakeRunner) deliverToWatcher() {
	deliver := f.deliver
	if deliver == nil {
		return
	}
	pid := f.submits[len(f.submits)-1].PendingID
	go func() {
		deliver(mustFrame(ctl.EventEntryAppend, ctl.EntryData{
			Entry: ctl.Entry{ID: "e-" + pid, Type: "message",
				Data: json.RawMessage(`{"queueIds":["` + pid + `"]}`)},
		}))
		deliver(mustFrame(ctl.EventIdle, ctl.IdleData{Idle: true}))
	}()
}

func (f *fakeRunner) StopSession(_ context.Context, sessionID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stopped = append(f.stopped, sessionID)
	return nil
}

func (f *fakeRunner) Subscribe(_ string, deliver func([]byte), onDrop func()) (*fleet.Subscription, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.subscribe++
	f.deliver = deliver
	f.onDrop = onDrop

	// model the reconciling init: a landing that committed before this
	// subscription attached still reaches the watcher through it
	if n := len(f.submits); n > 0 {
		pid := f.submits[n-1].PendingID
		go f.replay(pid)
	}
	return nil, nil // a fake needs no real subscription handle
}

// replay delivers the landing sequence for a prompt that already submitted.
func (f *fakeRunner) replay(pid string) {
	f.mu.Lock()
	deliver := f.deliver
	f.mu.Unlock()
	deliver(mustFrame(ctl.EventEntryAppend, ctl.EntryData{
		Entry: ctl.Entry{ID: "e-" + pid, Type: "message",
			Data: json.RawMessage(`{"queueIds":["` + pid + `"]}`)},
	}))
	deliver(mustFrame(ctl.EventIdle, ctl.IdleData{Idle: true}))
}

func (f *fakeRunner) Unsubscribe(*fleet.Subscription) {}

// mustFrame encodes one event as the stream frame the manager forwards.
func mustFrame(name string, data any) []byte {
	return mustJSON(fleet.EventFrame{
		Type:      fleet.FrameEvent,
		SessionID: "01RUNFAKESESSION00",
		Event:     ctl.NewEvent(name, 1, data),
	})
}

// mustJSON encodes v; only unreachable types fail.
func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic("sched: encode " + err.Error())
	}
	return b
}

// noRefireWindow is how long double-fire assertions watch for a stray run.
const noRefireWindow = 60 * time.Millisecond

// settleWindow bounds load-sensitive waits: every condition here arrives via
// an event-driven pipeline with its own retries, so the ceiling only needs
// headroom for slow scheduling and sqlite writes on a starved machine.
const settleWindow = 15 * time.Second

// testHarness wires one scheduler over a temp store with tight timings.
type testHarness struct {
	t      *testing.T
	sched  *Scheduler
	runner *fakeRunner
	store  *store.Store
	dir    string // real workspace directory jobs can point at
}

func newHarness(t *testing.T, mutate func(*Options)) *testHarness {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), store.FileName))
	require.NoError(t, err)
	t.Cleanup(func() { _ = st.Close() })

	runner := newFakeRunner()
	opts := Options{
		Log:    testLogger(),
		Store:  st,
		Runner: runner,
		Tick:   20 * time.Millisecond,
	}
	if mutate != nil {
		mutate(&opts)
	}
	return &testHarness{t: t, sched: New(opts), runner: runner, store: st, dir: t.TempDir()}
}

// start runs the scheduler for the test's duration.
func (h *testHarness) start(ctx context.Context) {
	h.sched.Start(ctx)
	h.t.Cleanup(h.sched.Stop)
}

// newHarnessWithRunner builds the harness over a caller-supplied runner, so
// tests can splice real fleet plumbing in behind a faked launch.
func newHarnessWithRunner(t *testing.T, runner Runner, mutate func(*Options)) *testHarness {
	t.Helper()
	return newHarness(t, func(o *Options) {
		o.Runner = runner
		if mutate != nil {
			mutate(o)
		}
	})
}

// addJob inserts one due interval job and returns its id.
func (h *testHarness) addJob(name string, mutate func(*store.Job)) int64 {
	h.t.Helper()
	j := store.Job{
		Name:            name,
		Workspace:       h.dir,
		Enabled:         true,
		ScheduleKind:    store.ScheduleInterval,
		IntervalSeconds: 1, // the smallest cadence seconds allow
		OnMissed:        store.MissSkip,
		Overlap:         store.OverlapRun,
		CreatedAt:       time.Now(),
	}
	if mutate != nil {
		mutate(&j)
	}
	id, err := h.store.CreateJob(h.t.Context(), j)
	require.NoError(h.t, err)
	return id
}

// runRows lists the runs recorded so far for one job.
func (h *testHarness) runRows(jobID int64) []store.Run {
	h.t.Helper()
	rows, err := h.store.Runs(h.t.Context(), jobID, 100)
	require.NoError(h.t, err)
	return rows
}

// waitForRun polls until one run of the job reached a terminal status.
func (h *testHarness) waitForRun(jobID int64, status string) store.Run {
	h.t.Helper()
	var hit store.Run
	require.Eventually(h.t, func() bool {
		for _, r := range h.runRows(jobID) {
			if r.Status == status {
				hit = r
				return true
			}
		}
		return false
	}, settleWindow, 10*time.Millisecond)
	return hit
}

// jobByID re-reads one job row.
func (h *testHarness) jobByID(id int64) store.Job {
	h.t.Helper()
	j, err := h.store.JobByID(h.t.Context(), id)
	require.NoError(h.t, err)
	return j
}

// submittedPrompt reads back the first prompt line the runner received.
func (h *testHarness) submittedPrompt() string {
	h.t.Helper()
	h.runner.mu.Lock()
	defer h.runner.mu.Unlock()
	return h.runner.submits[0].Line
}

func testLogger() *slog.Logger { return slog.New(slog.DiscardHandler) }

// noRefire watches one job across a quiet window and fails if a second run
// appears, proving a claimed slot never double-fires. Store reads after the
// test's context is cancelled count as quiet, so a late Never tick that lands
// outside the test body cannot fail the suite.
func (h *testHarness) requireNoRefire(jobID int64) {
	h.t.Helper()
	require.Never(h.t, func() bool {
		rows, err := h.store.Runs(h.t.Context(), jobID, 100)
		return err == nil && len(rows) > 1
	}, noRefireWindow, 20*time.Millisecond)
}
func TestScheduler(t *testing.T) {
	t.Run("fires interval job once", func(t *testing.T) {
		h := newHarness(t, nil)
		h.start(t.Context())

		id := h.addJob("cadence", func(j *store.Job) {
			j.IntervalSeconds = 3600 // no second slot may race the claim check
			slot := time.Now().Add(10 * time.Millisecond)
			j.NextRunAt = &slot
		})

		run := h.waitForRun(id, store.RunOK)

		// the schedule advanced far ahead: replaying the tick never double-fires
		h.requireNoRefire(id)
		assert.Len(t, h.runRows(id), 1)

		j := h.jobByID(id)
		require.NotNil(t, j.NextRunAt)
		assert.True(t, j.NextRunAt.After(run.StartedAt))
	})

	t.Run("survives restart without double firing", func(t *testing.T) {
		h := newHarness(t, nil)
		ctx := t.Context()

		id := h.addJob("restart", func(j *store.Job) {
			j.IntervalSeconds = 3600 // no further slot may interfere with the claim check
			slot := time.Now().Add(10 * time.Millisecond)
			j.NextRunAt = &slot
		})
		h.sched.Start(ctx)
		h.waitForRun(id, store.RunOK)
		h.sched.Stop()

		// a fresh scheduler over the same store does not refire the advanced slot
		again := New(h.sched.opts)
		again.Start(ctx)
		t.Cleanup(again.Stop)
		h.requireNoRefire(id)
		assert.Len(t, h.runRows(id), 1)
	})

	t.Run("missed policy skips", func(t *testing.T) {
		h := newHarness(t, func(o *Options) { o.MissedGrace = time.Second })
		h.start(t.Context())

		id := h.addJob("missed", func(j *store.Job) {
			slot := time.Now().Add(-5 * time.Second) // far past the tiny grace
			j.NextRunAt = &slot
		})

		run := h.waitForRun(id, store.RunSkipped)
		assert.Contains(t, run.Error, "missed")

		// the schedule advanced to a future slot instead of firing late
		j := h.jobByID(id)
		require.NotNil(t, j.NextRunAt)
		assert.True(t, j.NextRunAt.After(run.StartedAt))
	})

	t.Run("missed policy fires late", func(t *testing.T) {
		h := newHarness(t, func(o *Options) { o.MissedGrace = time.Second })
		h.start(t.Context())

		id := h.addJob("late", func(j *store.Job) {
			slot := time.Now().Add(-5 * time.Second)
			j.NextRunAt = &slot
			j.OnMissed = store.MissFireLate
		})

		run := h.waitForRun(id, store.RunOK) // fired once late instead of skipping

		// and the schedule advanced past the late fire instead of re-firing
		next := h.jobByID(id).NextRunAt
		require.NotNil(t, next)
		assert.True(t, next.After(run.StartedAt))
	})

	t.Run("once job fires and clears", func(t *testing.T) {
		h := newHarness(t, func(o *Options) { o.MissedGrace = time.Second })
		h.start(t.Context())

		slot := time.Now().Add(10 * time.Millisecond)
		id := h.addJob("oneshot", func(j *store.Job) {
			j.ScheduleKind = store.ScheduleOnce
			j.NextRunAt = &slot
		})

		run := h.waitForRun(id, store.RunOK)
		assert.Nil(h.t, h.jobByID(id).NextRunAt) // nothing left to fire

		h.requireNoRefire(id)
		assert.Equal(t, run.ID, h.runRows(id)[0].ID)

		// a one-shot past its grace is skipped, never fired
		late := time.Now().Add(-10 * time.Second)
		id2 := h.addJob("oneshot-late", func(j *store.Job) {
			j.ScheduleKind = store.ScheduleOnce
			j.NextRunAt = &late
		})
		skipped := h.waitForRun(id2, store.RunSkipped)
		assert.Contains(t, skipped.Error, "one-shot missed")
	})

	t.Run("global run limit", func(t *testing.T) {
		gate := make(chan struct{})
		h := newHarness(t, func(o *Options) { o.MaxConcurrent = 1 })
		h.runner.blockLaunch = gate
		h.start(t.Context())
		t.Cleanup(func() { close(gate) }) // after start: closes before Stop unwinds

		// the first due job occupies the single live slot
		first := h.addJob("holder", func(j *store.Job) {
			slot := time.Now().Add(10 * time.Millisecond)
			j.NextRunAt = &slot
		})
		h.waitForRun(first, store.RunRunning)

		// a second job due in the same window records why it could not run
		second := h.addJob("capped", func(j *store.Job) {
			slot := time.Now().Add(10 * time.Millisecond)
			j.NextRunAt = &slot
		})
		run := h.waitForRun(second, store.RunSkipped)
		assert.Contains(t, run.Error, "global run limit")
	})

	t.Run("manual fire works for disabled jobs", func(t *testing.T) {
		h := newHarness(t, nil)
		h.start(t.Context())

		id := h.addJob("manual", func(j *store.Job) {
			j.Enabled = false
			j.Prompt = "run the nightly sweep"
		})

		run, err := h.sched.FireNow(h.t.Context(), id)
		require.NoError(t, err)
		assert.Equal(t, store.TriggerManual, run.Trigger)

		got := h.waitForRun(id, store.RunOK)
		assert.Equal(t, "01RUNFAKESESSION00", got.SessionID)

		// a manual fire leaves the schedule alone
		j := h.jobByID(id)
		assert.False(t, j.Enabled)
		assert.Nil(h.t, j.NextRunAt)

		h.runner.mu.Lock()
		subs := len(h.runner.submits)
		stopped := slices.Clone(h.runner.stopped)
		h.runner.mu.Unlock()
		prompt := h.submittedPrompt()

		// the prompt went out with the run's own pendingId, and the session was
		// torn down because the job keeps nothing alive
		require.NotZero(t, subs)
		assert.Equal(t, "run the nightly sweep", prompt)
		assert.Contains(t, stopped, "01RUNFAKESESSION00")
	})

	t.Run("manual fire refuses when overlapping", func(t *testing.T) {
		gate := make(chan struct{})
		h := newHarness(t, nil)
		h.runner.blockLaunch = gate
		h.start(t.Context())
		t.Cleanup(func() { close(gate) }) // after start: closes before Stop unwinds

		id := h.addJob("busy", func(j *store.Job) {
			slot := time.Now().Add(10 * time.Millisecond)
			j.NextRunAt = &slot
			j.Overlap = store.OverlapSkipIfRunning
		})
		h.waitForRun(id, store.RunRunning)

		_, err := h.sched.FireNow(h.t.Context(), id)
		require.ErrorIs(t, err, store.ErrLiveRun)
	})

	t.Run("launch failure records reason", func(t *testing.T) {
		h := newHarness(t, nil)
		h.runner.launchErr = errors.New("spawn ajent: binary missing")
		h.start(t.Context())

		id := h.addJob("broken", func(j *store.Job) {
			slot := time.Now().Add(10 * time.Millisecond)
			j.NextRunAt = &slot
		})

		run := h.waitForRun(id, store.RunFailed)
		assert.Contains(t, run.Error, "binary missing")
		assert.Empty(t, run.SessionID)

		// the job keeps its cadence: a next slot was scheduled past the failure
		next := h.jobByID(id).NextRunAt
		require.NotNil(t, next)
		assert.True(t, next.After(run.StartedAt))
	})

	t.Run("nudge fires enabled job promptly", func(t *testing.T) {
		h := newHarness(t, nil)
		id := h.addJob("nudged", func(j *store.Job) {
			slot := time.Now().Add(10 * time.Millisecond)
			j.NextRunAt = &slot
		})
		h.start(t.Context())

		h.waitForRun(id, store.RunOK)

		// re-enabling with a fresh slot lands without waiting out the tick. The
		// slot sits just in the past on purpose: slots persist as whole unix
		// seconds, so a future millisecond slot can truncate nearly a full second
		// away and turn this into a boundary-timing test.
		slot := time.Now().Add(-10 * time.Millisecond)
		j := h.jobByID(id)
		j.NextRunAt = &slot
		require.NoError(h.t, h.store.UpdateJob(h.t.Context(), j))
		h.sched.Nudge()

		// a nudged edit lands within a tick or two; the generous ceiling matches
		// maxTick, since a loaded machine can starve the trigger loop longer than
		// any tighter bound would honestly allow
		require.Eventually(t, func() bool { return len(h.runRows(id)) == 2 },
			10*time.Second, 10*time.Millisecond)
	})

	t.Run("run when idle waits for quiet", func(t *testing.T) {
		h := newHarness(t, nil)
		// the fleet is busy right now: nothing may fire while the window holds
		h.runner.mu.Lock()
		h.runner.busyAt = time.Now()
		h.runner.mu.Unlock()

		slot := time.Now().Add(10 * time.Millisecond)
		id := h.addJob("idle-wait", func(j *store.Job) {
			j.IntervalSeconds = 3600 // no second slot may interfere
			j.NextRunAt = &slot
			j.RunWhenIdle = true
		})
		h.start(t.Context())

		require.Never(h.t, func() bool { return len(h.runRows(id)) > 0 },
			noRefireWindow, 20*time.Millisecond) // stays due without a run row

		// once ten quiet minutes pass, the held fire lands with no reason recorded
		h.runner.mu.Lock()
		h.runner.busyAt = time.Now().Add(-11 * time.Minute)
		h.runner.mu.Unlock()
		run := h.waitForRun(id, store.RunOK)
		assert.Empty(t, run.Error)

		// and the schedule advanced past the late slot: no missed-policy skip ran
		require.NotNil(t, h.jobByID(id).NextRunAt)
	})

	t.Run("idle past delay cap skips", func(t *testing.T) {
		h := newHarness(t, nil)
		h.runner.mu.Lock()
		h.runner.busyAt = time.Now() // busy for the whole test
		h.runner.mu.Unlock()

		slot := time.Now().Add(-2 * time.Hour) // held far past a 1h cap already
		id := h.addJob("idle-cap", func(j *store.Job) {
			j.IntervalSeconds = 3600
			j.NextRunAt = &slot
			j.RunWhenIdle = true
			j.IdleMaxDelaySeconds = 3600
		})
		h.start(t.Context())

		run := h.waitForRun(id, store.RunSkipped)
		assert.Contains(t, run.Error, "still busy")
		assert.Empty(t, run.SessionID)

		// the schedule advanced: the next slot will try again instead of re-deciding
		require.NotNil(t, h.jobByID(id).NextRunAt)
	})

	t.Run("idle without cap never skips", func(t *testing.T) {
		h := newHarness(t, nil)
		h.runner.mu.Lock()
		h.runner.busyAt = time.Now().Add(-2 * time.Hour) // idle already: fires at once
		h.runner.mu.Unlock()

		slot := time.Now().Add(10 * time.Millisecond)
		id := h.addJob("idle-forever", func(j *store.Job) {
			j.IntervalSeconds = 3600
			j.NextRunAt = &slot
			j.RunWhenIdle = true // zero cap waits, but idle now means fire now
		})
		h.start(t.Context())
		h.waitForRun(id, store.RunOK)
	})

	t.Run("trigger command gate", func(t *testing.T) {
		t.Run("success_gate_runs_on_zero", func(t *testing.T) {
			h := newHarness(t, nil)
			slot := time.Now().Add(10 * time.Millisecond)
			id := h.addJob("gate-ok", func(j *store.Job) {
				j.NextRunAt = &slot
				j.Prompt = "do the thing"
				j.TriggerCommand = "echo deployed"
			})
			h.start(t.Context())

			run := h.waitForRun(id, store.RunOK)
			prompt := h.submittedPrompt()

			assert.Contains(t, prompt, "Pre-run command `echo deployed` succeeded")
			assert.True(t, strings.HasSuffix(prompt, "do the thing"))
			assert.Empty(t, run.Error)
		})

		t.Run("success_gate_skips_on_error", func(t *testing.T) {
			h := newHarness(t, nil)
			slot := time.Now().Add(10 * time.Millisecond)
			id := h.addJob("gate-fail", func(j *store.Job) {
				j.NextRunAt = &slot
				j.Prompt = "do the thing"
				j.TriggerCommand = "exit 3"
			})
			h.start(t.Context())

			run := h.waitForRun(id, store.RunSkipped)
			assert.Contains(t, run.Error, "exited 3")
			assert.Empty(t, run.SessionID)
		})

		t.Run("error_gate_runs_on_failure", func(t *testing.T) {
			h := newHarness(t, nil)
			slot := time.Now().Add(10 * time.Millisecond)
			id := h.addJob("gate-on-error", func(j *store.Job) {
				j.NextRunAt = &slot
				j.Prompt = "do the thing"
				j.TriggerCommand = "exit 7"
				j.TriggerOn = store.TriggerOnError
			})
			h.start(t.Context())
			h.waitForRun(id, store.RunOK)
		})

		t.Run("error_gate_skips_on_success", func(t *testing.T) {
			h := newHarness(t, nil)
			slot := time.Now().Add(10 * time.Millisecond)
			id := h.addJob("gate-on-success-veto", func(j *store.Job) {
				j.NextRunAt = &slot
				j.Prompt = "do the thing"
				j.TriggerCommand = "true"
				j.TriggerOn = store.TriggerOnError
			})
			h.start(t.Context())
			run := h.waitForRun(id, store.RunSkipped)
			assert.Contains(t, run.Error, "exited 0")
		})

		t.Run("gate_output_prepends_prompt", func(t *testing.T) {
			h := newHarness(t, nil)
			slot := time.Now().Add(10 * time.Millisecond)
			id := h.addJob("gate-output", func(j *store.Job) {
				j.NextRunAt = &slot
				j.Prompt = "summarize the changes"
				j.TriggerCommand = "printf 'line one\\nline two'"
			})
			h.start(t.Context())
			h.waitForRun(id, store.RunOK)
			prompt := h.submittedPrompt()

			assert.Contains(t, prompt, "line one\nline two")
			assert.True(t, strings.HasSuffix(prompt, "summarize the changes"))
		})

		t.Run("launcher_job_skips_without_prompt", func(t *testing.T) {
			h := newHarness(t, nil)
			slot := time.Now().Add(10 * time.Millisecond)
			id := h.addJob("gate-launcher", func(j *store.Job) {
				j.NextRunAt = &slot
				j.Prompt = ""
				j.TriggerCommand = "exit 1"
			})
			h.start(t.Context())
			run := h.waitForRun(id, store.RunSkipped)
			assert.Empty(t, run.SessionID)
		})

		t.Run("gate_runs_in_job_workspace", func(t *testing.T) {
			h := newHarness(t, nil)
			ws := t.TempDir()
			slot := time.Now().Add(10 * time.Millisecond)
			id := h.addJob("gate-workspace", func(j *store.Job) {
				j.NextRunAt = &slot
				j.Prompt = "do the thing"
				j.Workspace = ws
				j.TriggerCommand = "pwd"
			})
			h.start(t.Context())
			run := h.waitForRun(id, store.RunOK)
			prompt := h.submittedPrompt()

			assert.Empty(t, run.Error)
			assert.Contains(t, prompt, "Pre-run command `pwd` succeeded")
			assert.Contains(t, prompt, ws)
		})

		t.Run("empty_workspace_inherits_cwd", func(t *testing.T) {
			h := newHarness(t, nil)
			slot := time.Now().Add(10 * time.Millisecond)
			id := h.addJob("gate-inherit", func(j *store.Job) {
				j.NextRunAt = &slot
				j.Prompt = "do the thing"
				j.Workspace = "" // an optional/legacy field must not break firing
				j.TriggerCommand = "pwd"
			})
			h.start(t.Context())
			run := h.waitForRun(id, store.RunOK)
			prompt := h.submittedPrompt()

			wd, err := os.Getwd() // the gate ran from swarm's own working directory
			require.NoError(t, err)
			assert.Empty(t, run.Error)
			assert.Contains(t, prompt, "Pre-run command `pwd` succeeded")
			assert.Contains(t, prompt, wd)
		})
	})
}
