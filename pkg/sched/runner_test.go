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
	return h.sched.awaitSettled(run, j, in)
}

// runRow re-reads one run row's persisted state.
func (h *testHarness) runRow(id int64) store.Run {
	h.t.Helper()
	run, err := h.store.RunByID(h.t.Context(), id)
	require.NoError(h.t, err)
	return run
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

	t.Run("records_awaiting_input", func(t *testing.T) {
		// a dialog that stays open parks the row for the UI to see, until its
		// bounded timeout lands
		h := newHarness(t, func(o *Options) { o.RunTimeoutDefault = 30 * time.Millisecond })
		j := sampleJob(store.ScheduleOnce)
		run := h.seedRun(h.addJob("watch-parked", nil))
		status, _ := h.scriptWatcher(run, j,
			initFrame(),
			landingFrame(pendingID(run)),
			dialogFrame(7),
		)
		assert.Equal(t, store.RunTimeout, status)
		assert.Equal(t, store.RunAwaitingInput, h.runRow(run.ID).Status)

		// once the human answers and idle arrives, the run still concludes ok
		h2 := newHarness(t, nil)
		run2 := h2.seedRun(h2.addJob("watch-settled", nil))
		status, _ = h2.scriptWatcher(run2, j,
			initFrame(),
			landingFrame(pendingID(run2)),
			dialogFrame(8),
			settledFrame(8),
			idleFrame(),
		)
		assert.Equal(t, store.RunOK, status)
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

	t.Run("timeout_notes", func(t *testing.T) {
		h := newHarness(t, func(o *Options) { o.RunTimeoutDefault = 30 * time.Millisecond })
		j := sampleJob(store.ScheduleOnce)

		t.Run("parked_at_dialog", func(t *testing.T) {
			run := h.seedRun(h.addJob("watch-parked", nil))
			status, note := h.scriptWatcher(run, j,
				initFrame(),
				landingFrame(pendingID(run)),
				dialogFrame(9),
			)
			assert.Equal(t, store.RunTimeout, status)
			assert.Contains(t, note, "parked at an open dialog")
		})

		t.Run("never_accepted", func(t *testing.T) {
			run := h.seedRun(h.addJob("watch-quiet", nil))
			status, note := h.scriptWatcher(run, j, initFrame())
			assert.Equal(t, store.RunTimeout, status)
			assert.Contains(t, note, "never accepted")
		})
	})

	t.Run("ignores_unrelated_traffic", func(t *testing.T) {
		h := newHarness(t, func(o *Options) { o.RunTimeoutDefault = 30 * time.Millisecond })
		j := sampleJob(store.ScheduleOnce)
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
		h := newHarness(t, func(o *Options) { o.RunTimeoutDefault = 50 * time.Millisecond })
		j := sampleJob(store.ScheduleOnce)
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

		runID := int64(0)
		require.Eventually(t, func() bool {
			for _, r := range env.h.runRows(id) {
				if r.Status == store.RunAwaitingInput {
					runID = r.ID
					return true
				}
			}
			return false
		}, settleWindow, 10*time.Millisecond)
		require.NotZero(t, runID)
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
