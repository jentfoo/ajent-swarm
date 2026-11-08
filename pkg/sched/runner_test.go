package sched

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent-swarm/pkg/store"
	"github.com/jentfoo/ajent-swarm/pkg/testutil"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// landingFrame is the committed entry a prompt's queueIds ride.
func landingFrame(pid string) []byte {
	return eventFrame(ctl.EventEntryAppend, ctl.EntryData{
		Entry: ctl.Entry{ID: "e1", Type: "message",
			Data: json.RawMessage(`{"queueIds":["` + pid + `"]}`)},
	})
}

func idleFrame() []byte {
	return eventFrame(ctl.EventIdle, ctl.IdleData{Idle: true})
}

func dialogFrame(id uint64) []byte {
	return eventFrame(ctl.EventInteractionPending,
		ctl.InteractionPendingData{ID: id, Kind: "confirm", Prompt: "allow?"})
}

func settledFrame(id uint64) []byte {
	return eventFrame(ctl.EventInteractionSettled,
		ctl.InteractionSettledData{ID: id, Answered: true})
}

func droppedFrame(pid string) []byte {
	return eventFrame(ctl.EventQueueDropped, ctl.QueueDroppedData{
		Rows:  []ctl.QueueRow{{ID: pid}},
		Cause: "interrupt",
	})
}

func exitFrame(reason string) []byte {
	return eventFrame(ctl.EventSessionExit, ctl.SessionExitData{Reason: reason})
}

// initFrame is the subscribe greeting beside its committed entry tail.
func initFrame(entries ...ctl.Entry) []byte {
	f := fleet.InitFrame{Type: fleet.FrameInit, SessionID: "01RUNFAKESESSION00",
		State: ctl.State{}, Entries: entries}
	return mustJSON(f)
}

func eventFrame(name string, data any) []byte {
	return mustJSON(fleet.EventFrame{
		Type:      fleet.FrameEvent,
		SessionID: "01RUNFAKESESSION00",
		Event:     ctl.NewEvent(name, 1, data),
	})
}

// seedRun records one live run row to watch, returning it.
func (h *testHarness) seedRun(jobID int64) store.Run {
	h.t.Helper()
	job := jobID
	id, err := h.store.BeginManualRun(h.t.Context(), job, false, 10, store.Run{
		JobID:     &job,
		Prompt:    "go",
		Trigger:   store.TriggerSchedule,
		Status:    store.RunRunning,
		StartedAt: time.Now(),
	})
	require.NoError(h.t, err)
	run, err := h.store.RunByID(h.t.Context(), id)
	require.NoError(h.t, err)
	return run
}

// scriptWatcher plays one scripted frame sequence into awaitSettled.
func (h *testHarness) scriptWatcher(run store.Run, j store.Job, frames ...[]byte) (string, string) {
	h.t.Helper()
	in := make(chan []byte, len(frames)+1)
	for _, f := range frames {
		in <- f
	}
	close(in)
	status := h.sched.awaitSettled(run, j, in)
	return status.status, status.err
}

// shrinkTimeout scales configured minutes down so tests arm real budgets in
// milliseconds.
func shrinkTimeout(t *testing.T) {
	t.Helper()
	old := timeoutUnit
	timeoutUnit = time.Millisecond
	t.Cleanup(func() { timeoutUnit = old })
}

// TestRunBudget checks the zero and negative rows watch unbounded while a
// configured budget converts through the timeout unit.
func TestRunBudget(t *testing.T) {
	_, bounded := runBudget(0)
	assert.False(t, bounded)

	_, bounded = runBudget(-5)
	assert.False(t, bounded)

	d, bounded := runBudget(30)
	assert.True(t, bounded)
	assert.Equal(t, 30*time.Minute, d)
}

func TestRunner(t *testing.T) {
	t.Run("settles_on_landing_then_idle", func(t *testing.T) {
		h := newHarness(t, nil)
		j := sampleJob(store.ScheduleOnce)
		run := h.seedRun(h.addJob("watch", nil))

		status, note := h.scriptWatcher(run, j,
			initFrame(), // pre-landing baseline
			landingFrame(pendingID(run)),
			idleFrame(),
		)
		assert.Equal(t, store.RunOK, status)
		assert.Empty(t, note)
	})

	t.Run("settles_after_dialog_answer", func(t *testing.T) {
		h := newHarness(t, nil)
		j := sampleJob(store.ScheduleOnce)
		run := h.seedRun(h.addJob("watch", nil))

		// a dialog that opens and closes mid-run parks and resumes the row
		status, note := h.scriptWatcher(run, j,
			initFrame(),
			landingFrame(pendingID(run)),
			dialogFrame(8),
			settledFrame(8),
			idleFrame(),
		)
		assert.Equal(t, store.RunOK, status)
		assert.Empty(t, note)
	})

	t.Run("landing_via_init_entries", func(t *testing.T) {
		h := newHarness(t, nil)
		j := sampleJob(store.ScheduleOnce)
		run := h.seedRun(h.addJob("watch", nil))

		// a re-subscribe greets with an init whose tail already holds the landing
		status, _ := h.scriptWatcher(run, j,
			initFrame(ctl.Entry{ID: "e1", Type: "message",
				Data: json.RawMessage(`{"queueIds":["` + pendingID(run) + `"]}`)}),
			idleFrame(),
		)
		assert.Equal(t, store.RunOK, status)
	})

	t.Run("init_settles_landed_idle", func(t *testing.T) {
		h := newHarness(t, nil)
		j := sampleJob(store.ScheduleOnce)
		run := h.seedRun(h.addJob("watch", nil))

		// the subscription attached after both facts happened: a submit whose
		// landing and idle were applied to the view before any subscriber sat
		// down arrives as one init carrying them together, with no event after
		f := fleet.InitFrame{Type: fleet.FrameInit, SessionID: "01RUNFAKESESSION00",
			State: ctl.State{Idle: true},
			Entries: []ctl.Entry{{ID: "e1", Type: "message",
				Data: json.RawMessage(`{"queueIds":["` + pendingID(run) + `"]}`)}}}
		status, note := h.scriptWatcher(run, j, mustJSON(f))
		assert.Equal(t, store.RunOK, status)
		assert.Empty(t, note)
	})

	t.Run("fails_on_prompt_drop", func(t *testing.T) {
		h := newHarness(t, nil)
		j := sampleJob(store.ScheduleOnce)
		run := h.seedRun(h.addJob("watch", nil))

		status, note := h.scriptWatcher(run, j,
			initFrame(),
			droppedFrame(pendingID(run)),
		)
		assert.Equal(t, store.RunFailed, status)
		assert.Contains(t, note, "interrupt")
	})

	t.Run("fails_on_early_exit", func(t *testing.T) {
		h := newHarness(t, nil)
		j := sampleJob(store.ScheduleOnce)
		run := h.seedRun(h.addJob("watch", nil))

		status, note := h.scriptWatcher(run, j,
			initFrame(),
			exitFrame("done for now"),
		)
		assert.Equal(t, store.RunFailed, status)
		assert.Contains(t, note, "done for now")

		// after the prompt landed, a clean exit completes the run instead
		status, _ = h.scriptWatcher(run, j,
			initFrame(),
			landingFrame(pendingID(run)),
			exitFrame("done for now"),
		)
		assert.Equal(t, store.RunOK, status)
	})

	t.Run("ignores_unrelated_traffic", func(t *testing.T) {
		shrinkTimeout(t)
		h := newHarness(t, nil)
		j := sampleJob(store.ScheduleOnce)
		j.TimeoutMinutes = 30 // a real budget in shrunken milliseconds
		run := h.seedRun(h.addJob("watch", nil))

		// other prompts' landings and garbage frames never conclude our run
		status, _ := h.scriptWatcher(run, j,
			initFrame(),
			landingFrame(pendingID(store.Run{ID: 99999})),
			[]byte("{not json"),
			eventFrame(ctl.EventIdle, ctl.IdleData{Idle: true}),
		)
		assert.Equal(t, store.RunTimeout, status) // our landing never came
	})

	t.Run("fails_when_submit_never_lands", func(t *testing.T) {
		shrinkTimeout(t)
		h := newHarness(t, nil)
		j := sampleJob(store.ScheduleOnce)
		j.TimeoutMinutes = 50 // a real budget in shrunken milliseconds
		run := h.seedRun(h.addJob("watch", nil))

		// the queue holds our row uncommitted: no landing ever commits
		queued := eventFrame(ctl.EventQueued, ctl.QueuedData{
			Rows: []ctl.QueueRow{{ID: pendingID(run), Text: "go"}},
		})
		status, note := h.scriptWatcher(run, j,
			initFrame(),
			queued,
		)
		assert.Equal(t, store.RunTimeout, status)
		assert.Contains(t, note, "never accepted")
	})

	t.Run("zero_timeout_never_fires", func(t *testing.T) {
		shrinkTimeout(t) // any finite budget would conclude long before shutdown
		h := newHarness(t, nil)
		h.start(t.Context())
		j := sampleJob(store.ScheduleOnce)
		run := h.seedRun(h.addJob("watch", nil))

		frames := make(chan []byte) // no traffic: only shutdown may conclude it
		done := make(chan outcome, 1)
		go func() { done <- h.sched.awaitSettled(run, j, frames) }()
		h.sched.Stop()

		var o outcome
		require.Eventually(t, func() bool {
			select {
			case o = <-done:
				return true
			default:
				return false
			}
		}, settleWindow, 10*time.Millisecond)
		assert.Equal(t, store.RunFailed, o.status)
		assert.Contains(t, o.err, "interrupt")
	})

	t.Run("applies_custom_tools_before_submit", func(t *testing.T) {
		h := newHarness(t, nil)
		id := h.fireWithTools("tooled", " web_search , builtin:read ")
		h.start(t.Context())

		h.waitForRun(id, store.RunOK)

		h.runner.mu.Lock()
		toolsSets := slices.Clone(h.runner.toolsSets)
		ops := slices.Clone(h.runner.ops)
		h.runner.mu.Unlock()
		// the set applied once, parsed onto clean names, ahead of the prompt so
		// ajent's widen-only rule never sees a dispatched turn first
		require.Len(h.t, toolsSets, 1)
		assert.Equal(t, []string{"builtin:read", "web_search"}, toolsSets[0])
		assert.Equal(t, []string{"tools", "submit"}, ops)
	})

	t.Run("default_job_never_touches_tools", func(t *testing.T) {
		h := newHarness(t, nil)
		id := h.addJob("default-tools", func(j *store.Job) {
			j.Prompt = "run the checks"
			slot := time.Now().Add(10 * time.Millisecond)
			j.NextRunAt = &slot
		})
		h.start(t.Context())

		h.waitForRun(id, store.RunOK)

		h.runner.mu.Lock()
		toolsSets := slices.Clone(h.runner.toolsSets)
		h.runner.mu.Unlock()
		assert.Empty(h.t, toolsSets) // session defaults stay untouched
	})

	t.Run("tools_failure_fails_run", func(t *testing.T) {
		h := newHarness(t, nil)
		h.runner.toolsSetErr = errors.New("no tool gate on this session") // not retriable
		id := h.fireWithTools("tooled-broken", "builtin:read")
		h.start(t.Context())

		run := h.waitForRun(id, store.RunFailed)
		assert.Contains(t, run.Error, "no tool gate")

		// the prompt never landed behind the failed reshape
		h.runner.mu.Lock()
		submits := slices.Clone(h.runner.submits)
		h.runner.mu.Unlock()
		assert.Empty(h.t, submits)
	})

	t.Run("titles_session_from_job_name", func(t *testing.T) {
		h := newHarness(t, nil)
		id := h.addJob("nightly sweep", func(j *store.Job) {
			j.Prompt = "run the checks"
			slot := time.Now().Add(10 * time.Millisecond)
			j.NextRunAt = &slot
		})
		h.start(t.Context())

		run := h.waitForRun(id, store.RunOK)

		h.runner.mu.Lock()
		title := h.runner.titles[run.SessionID]
		h.runner.mu.Unlock()
		assert.Equal(t, "nightly sweep", title)
	})

	t.Run("launcher_job_titled_without_prompt", func(t *testing.T) {
		h := newHarness(t, nil)
		id := h.addJob("serve workspace", func(j *store.Job) {
			j.Prompt = "" // a launcher job: serving is the whole deliverable
			slot := time.Now().Add(10 * time.Millisecond)
			j.NextRunAt = &slot
		})
		h.start(t.Context())

		run := h.waitForRun(id, store.RunOK)

		h.runner.mu.Lock()
		title := h.runner.titles[run.SessionID]
		h.runner.mu.Unlock()
		assert.Equal(t, "serve workspace", title)
	})

	// a resumed session already carries its own history; the job label may not
	// stomp whatever it is called today
	t.Run("resume_mode_keeps_session_title", func(t *testing.T) {
		h := newHarness(t, nil)
		id := h.addJob("resumed", func(j *store.Job) {
			j.Prompt = "run the checks"
			j.SpawnMode = string(fleet.LaunchResume)
			slot := time.Now().Add(10 * time.Millisecond)
			j.NextRunAt = &slot
		})
		h.start(t.Context())
		h.waitForRun(id, store.RunOK)

		h.runner.mu.Lock()
		titled := len(h.runner.titles)
		h.runner.mu.Unlock()
		assert.Empty(t, titled)
	})

	t.Run("empty_name_skips_title", func(t *testing.T) {
		h := newHarness(t, nil)
		id := h.addJob("", func(j *store.Job) {
			j.Prompt = "run the checks"
			slot := time.Now().Add(10 * time.Millisecond)
			j.NextRunAt = &slot
		})
		h.start(t.Context())
		h.waitForRun(id, store.RunOK)

		h.runner.mu.Lock()
		titled := len(h.runner.titles)
		h.runner.mu.Unlock()
		assert.Empty(t, titled)
	})

	t.Run("title_failure_keeps_run_ok", func(t *testing.T) {
		h := newHarness(t, nil)
		h.runner.titleErr = errors.New("no session title store configured")
		id := h.addJob("unlabelable", func(j *store.Job) {
			j.Prompt = "run the checks"
			slot := time.Now().Add(10 * time.Millisecond)
			j.NextRunAt = &slot
		})
		h.start(t.Context())

		run := h.waitForRun(id, store.RunOK)

		assert.Empty(t, run.Error) // the failed label write never gates the run
		assert.Equal(t, "run the checks", h.submittedPrompt())
	})

	t.Run("submit_retries_through_refusals", func(t *testing.T) {
		h := newHarness(t, nil)
		// a resumed session whose old dialog is still open refuses briefly
		h.runner.submitFailN = 2
		prevEvery := submitEvery
		submitEvery = 5 * time.Millisecond // retry cadence out of the way
		t.Cleanup(func() { submitEvery = prevEvery })
		id := h.addJob("resumed", func(j *store.Job) {
			j.Prompt = "run the checks"
			j.IntervalSeconds = 3600 // no second slot may race the attempt count
			slot := time.Now().Add(10 * time.Millisecond)
			j.NextRunAt = &slot
		})
		h.start(t.Context())

		got := h.waitForRun(id, store.RunOK)

		h.runner.mu.Lock()
		attempts := len(h.runner.submits)
		h.runner.mu.Unlock()
		assert.Equal(t, 3, attempts) // two refused, the third landed
		assert.NotEmpty(t, got.SessionID)
	})

	t.Run("queued_run_keeps_session", func(t *testing.T) {
		h := newHarness(t, nil)
		id := h.addQueuedJob("queued sweep", "review the diff")
		h.start(t.Context())

		require.Eventually(t, func() bool {
			_, err := h.store.JobByID(h.t.Context(), id)
			return errors.Is(err, store.ErrNotFound)
		}, settleWindow, 10*time.Millisecond)

		// history survives unlinked: the prompt's row reads as an ad-hoc run
		rows, err := h.store.Runs(h.t.Context(), 0, 100)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Nil(t, rows[0].JobID)
		assert.Equal(t, store.RunOK, rows[0].Status)
		assert.Equal(t, "review the diff", rows[0].Prompt)
		assert.NotEmpty(t, rows[0].SessionID)

		// keep_alive won: the row was read before the delete, nothing was stopped
		h.runner.mu.Lock()
		stopped := slices.Clone(h.runner.stopped)
		h.runner.mu.Unlock()
		assert.Empty(t, stopped)
	})

	t.Run("queued_capacity_skip_deletes_job", func(t *testing.T) {
		gate := make(chan struct{})
		h := newHarness(t, func(o *Options) { o.MaxConcurrent = 1 })
		h.runner.blockLaunch = gate
		h.start(t.Context())
		t.Cleanup(func() { close(gate) }) // after start: closes before Stop unwinds

		// the lone live slot belongs to the first queued job's parked launch
		first := h.addQueuedJob("first", "first prompt")
		h.waitForRun(first, store.RunRunning)

		second := h.addQueuedJob("second", "second prompt")
		require.Eventually(t, func() bool {
			_, err := h.store.JobByID(h.t.Context(), second)
			return errors.Is(err, store.ErrNotFound)
		}, settleWindow, 10*time.Millisecond)

		rows, err := h.store.Runs(h.t.Context(), 0, 100)
		require.NoError(t, err)
		var skipped *store.Run
		for i := range rows {
			if rows[i].Prompt == "second prompt" {
				skipped = &rows[i]
			}
		}
		require.NotNil(t, skipped)
		assert.Equal(t, store.RunSkipped, skipped.Status)
		assert.Contains(t, skipped.Error, "global run limit")
		assert.Nil(t, skipped.JobID) // unlinked by the delete
	})

	t.Run("queued_run_keeps_stub", func(t *testing.T) {
		// the queued flow against a real manager and stub server: the run lands,
		// the row goes and the session is never told to exit; not parallel, since
		// it pins AJENT_HOME for the process-wide discovery default
		env, _ := newE2ESched(t, nil)

		env.onSubmit("review the diff", func(pendingID string) {
			env.stub.Broadcast(ctl.EventEntryAppend, ctl.EntryData{
				Entry: ctl.Entry{ID: "e1", Type: "message",
					Data: json.RawMessage(`{"queueIds":["` + pendingID + `"]}`)},
			})
			env.stub.Broadcast(ctl.EventIdle, ctl.IdleData{Idle: true})
		})

		id := env.h.addQueuedJob("queued sweep", "review the diff")
		env.h.sched.Start(t.Context())
		t.Cleanup(env.h.sched.Stop)

		require.Eventually(t, func() bool {
			_, err := env.h.store.JobByID(env.h.t.Context(), id)
			return errors.Is(err, store.ErrNotFound)
		}, settleWindow, 10*time.Millisecond)

		// the prompt landed, and no stop line ever followed it
		var submitted bool
		for _, req := range env.stub.Received() {
			if req.Method != ctl.MethodSubmit {
				continue
			}
			var p ctl.SubmitParams
			_ = json.Unmarshal(req.Params, &p)
			if p.Line == "review the diff" {
				submitted = true
			} else {
				assert.False(t, strings.HasPrefix(p.Line, "/exit"))
			}
		}
		assert.True(t, submitted)
	})

	t.Run("end_to_end_through_fleet", func(t *testing.T) {
		// one run against a real manager and stub server, so the watcher consumes
		// genuinely encoded frames from a live actor; not parallel, since it pins
		// AJENT_HOME for the process-wide discovery default
		env, _ := newE2ESched(t, nil)

		// the stub cannot run prompts; once our submit lands it plays the landing
		// sequence a real ajent would emit for that pendingId
		env.onSubmit("say hi", func(pendingID string) {
			env.stub.Broadcast(ctl.EventEntryAppend, ctl.EntryData{
				Entry: ctl.Entry{ID: "e1", Type: "message",
					Data: json.RawMessage(`{"queueIds":["` + pendingID + `"]}`)},
			})
			env.stub.Broadcast(ctl.EventIdle, ctl.IdleData{Idle: true})
		})

		id := env.addOnceJob(t, "say hi")
		env.h.sched.Start(t.Context())
		t.Cleanup(env.h.sched.Stop)

		run := env.h.waitForRun(id, store.RunOK)
		assert.Equal(t, env.stub.SessionID(), run.SessionID)

		// the prompt went out with its synthetic pendingId and teardown followed;
		// /exit trails the terminal row finish persists, so poll until it lands
		var submits []string
		require.Eventually(t, func() bool {
			submits = nil
			for _, req := range env.stub.Received() {
				if req.Method == ctl.MethodSubmit {
					var p ctl.SubmitParams
					_ = json.Unmarshal(req.Params, &p)
					submits = append(submits, p.Line+"|"+p.PendingID)
				}
			}
			return len(submits) >= 2
		}, settleWindow, 10*time.Millisecond)
		assert.Equal(t, fmt.Sprintf("say hi|run-%d", run.ID), submits[0])
		assert.True(t, strings.HasPrefix(submits[1], "/exit")) // swarm's stop line
	})

	t.Run("parks_at_dialog_through_fleet", func(t *testing.T) {
		// the awaiting_input transition against a stub holding a dialog open: the
		// row parks for the UI to see instead of failing; not parallel (AJENT_HOME)
		env, _ := newE2ESched(t, nil)

		// no landing ever commits: the permission barrier holds the editor
		env.onSubmit("deploy", func(string) {
			env.stub.Broadcast(ctl.EventInteractionPending,
				ctl.InteractionPendingData{ID: 9, Kind: "confirm",
					Prompt: "allow production deploy?", Options: []string{"yes", "no"}})
		})

		id := env.addOnceJob(t, "deploy")
		env.h.sched.Start(t.Context())
		t.Cleanup(env.h.sched.Stop)

		require.Eventually(t, func() bool {
			for _, r := range env.h.runRows(id) {
				if r.Status == store.RunAwaitingInput {
					return true
				}
			}
			return false
		}, settleWindow, 10*time.Millisecond)
	})
}

func (h *testHarness) fireWithTools(name, tools string) int64 {
	return h.addJob(name, func(j *store.Job) {
		j.Prompt = "run the checks"
		j.ToolsCustom = true
		j.Tools = tools
		slot := time.Now().Add(10 * time.Millisecond)
		j.NextRunAt = &slot
	})
}

type e2eEnv struct {
	stub *fleettest.Stub
	h    *testHarness
}

func e2ePID(t *testing.T) int {
	t.Helper()
	cmd := exec.CommandContext(t.Context(), os.Args[0], "-test.run=^$")
	require.NoError(t, cmd.Run())
	return cmd.Process.Pid
}

func newE2ESched(t *testing.T, mutate func(*Options)) (*e2eEnv, string) {
	t.Helper()
	prevGap, prevEvery := resubscribeGap, submitEvery
	resubscribeGap = 10 * time.Millisecond // e2e retry gaps stay out of the timings
	submitEvery = 10 * time.Millisecond
	t.Cleanup(func() { resubscribeGap, submitEvery = prevGap, prevEvery })
	home := testutil.IsolateHome(t)

	pid := e2ePID(t)
	stub := fleettest.New(t, home, fleettest.Options{SessionID: "01RUNE2ESession00", PID: pid})
	stub.WriteRegistry(t, pid, time.Now())

	mgr := newE2EFleet(t)
	fake := newFakeRunner()
	fake.sessionID = stub.SessionID() // the launch hands back the stub's session
	env := &e2eEnv{
		stub: stub,
		h:    newHarnessWithRunner(t, &launchStub{Manager: mgr, fake: fake}, mutate),
	}
	return env, home
}

// onSubmit reacts to the run's prompt submit the moment it lands; the stub
// invokes the hook synchronously from its request loop.
func (env *e2eEnv) onSubmit(line string, react func(pendingID string)) {
	env.stub.OnSubmit(func(p ctl.SubmitParams) {
		if p.Line == line && p.PendingID != "" {
			react(p.PendingID)
		}
	})
}

func (env *e2eEnv) addOnceJob(t *testing.T, prompt string) int64 {
	t.Helper()
	return env.h.addJob("e2e", func(j *store.Job) {
		j.ScheduleKind = store.ScheduleOnce
		j.Prompt = prompt
		slot := time.Now().Add(10 * time.Millisecond)
		j.NextRunAt = &slot
	})
}

func newE2EFleet(t *testing.T) *fleet.Manager {
	t.Helper()
	mgr := fleet.New(fleet.Options{
		Log:          testLogger(),
		PollInterval: 10 * time.Millisecond,
		BackoffBase:  5 * time.Millisecond,
		BackoffMax:   50 * time.Millisecond,
	})
	mgr.Start(t.Context())
	t.Cleanup(mgr.Stop)
	return mgr
}

type launchStub struct {
	*fleet.Manager
	fake *fakeRunner
}

func (l *launchStub) Launch(ctx context.Context, req fleet.LaunchRequest) (fleet.LaunchResult, error) {
	return l.fake.Launch(ctx, req)
}
