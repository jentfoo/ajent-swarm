package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"

	"github.com/jentfoo/ajent-swarm/pkg/auth"
	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	"github.com/jentfoo/ajent-swarm/pkg/sched"
	"github.com/jentfoo/ajent-swarm/pkg/store"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// scriptRunner fakes the scheduler's fleet surface at the API test level:
// launches return a fixed session, with an optional parking gate.
type scriptRunner struct {
	mu        sync.Mutex
	session   string
	pendingID string // the last submitted prompt, replayed on subscribe
	stopped   []string
	deliver   func([]byte)  // the watcher's frame sink once subscribed
	watchOnce sync.Once     // guards watched
	watched   chan struct{} // closed when the run's watcher subscribes

	block chan struct{}
	ctx   context.Context // launch ctx, canceled with the test
}

func (r *scriptRunner) Launch(ctx context.Context, _ fleet.LaunchRequest) (fleet.LaunchResult, error) {
	r.mu.Lock()
	gate := r.block
	r.ctx = ctx
	r.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done(): // cleanup closed the gate or canceled the run
		}
	}
	return fleet.LaunchResult{SessionID: r.session}, nil
}

// LastBusyAt reports a quiet fleet, no job in these tests waits for idle.
func (r *scriptRunner) LastBusyAt() time.Time { return time.Time{} }

// ClaimRelease always grants the lone idle point, NoteRelease is a no-op.
func (r *scriptRunner) ClaimRelease(time.Duration) bool { return true }
func (r *scriptRunner) NoteRelease()                    {}

func (r *scriptRunner) Submit(_ context.Context, _ string, params ctl.SubmitParams) error {
	r.mu.Lock()
	r.pendingID = params.PendingID // remembered for a later subscription's replay
	r.mu.Unlock()

	go r.playLanding(params.PendingID)
	return nil
}

// playLanding emits the committed-entry-then-idle sequence a real ajent
// produces once it accepts a prompt. It waits for the watcher to attach, so
// the landing is never dropped by an ordering race.
func (r *scriptRunner) playLanding(pid string) {
	select { // a run that never subscribed has no landing to deliver
	case <-r.watched:
	case <-r.ctx.Done():
		return
	}

	r.mu.Lock()
	deliver := r.deliver
	r.mu.Unlock()
	if deliver == nil {
		return
	}
	deliver(mustJSONFrame(fleet.EventFrame{
		Type: fleet.FrameEvent, SessionID: r.session,
		Event: ctl.NewEvent(ctl.EventEntryAppend, 1, ctl.EntryData{
			Entry: ctl.Entry{ID: "e-" + pid, Type: "message",
				Data: json.RawMessage(`{"queueIds":["` + pid + `"]}`)},
		}),
	}))
	deliver(mustJSONFrame(fleet.EventFrame{
		Type: fleet.FrameEvent, SessionID: r.session,
		Event: ctl.NewEvent(ctl.EventIdle, 2, ctl.IdleData{Idle: true}),
	}))
}

// mustJSONFrame encodes one stream frame, only unreachable types fail.
func mustJSONFrame(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic("api test: encode " + err.Error())
	}
	return b
}

func (r *scriptRunner) StopSession(_ context.Context, sessionID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stopped = append(r.stopped, sessionID)
	return nil
}

// ToolsSet answers nothing here: no API-level job test uses custom tools.
func (r *scriptRunner) ToolsSet(_ context.Context, _ string,
	_ []string) (ctl.ToolsSetResult, error) {
	return ctl.ToolsSetResult{}, nil
}

// SetTitle answers nothing here: the manager's title store owns real labels.
func (r *scriptRunner) SetTitle(_ context.Context, _, _ string) error { return nil }

func (r *scriptRunner) Subscribe(_ string, deliver func([]byte), _ func()) (*fleet.Subscription, error) {
	r.mu.Lock()
	r.deliver = deliver
	submitted := r.pendingID != ""
	r.watchOnce.Do(func() { close(r.watched) })
	r.mu.Unlock()

	// mirror fleet's greeting: a fresh subscription reconciles through an
	// init-shaped landing replay when the prompt already went out
	if submitted {
		go r.playLanding(r.pendingID)
	}
	return nil, nil
}

func (r *scriptRunner) Unsubscribe(*fleet.Subscription) {}

// schedEnv is one full API server wired to a live scheduler over a temp store.
type schedEnv struct {
	server *httptest.Server
	sched  *sched.Scheduler
	runner *scriptRunner
	store  *store.Store
	dir    string
}

// newSchedEnv builds the phase 06 endpoints with tight timings and an
// authenticated client.
func newSchedEnv(t *testing.T) (*schedEnv, *http.Client) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), store.FileName))
	require.NoError(t, err)
	t.Cleanup(func() { _ = st.Close() })

	svc, err := auth.NewService(st, auth.WithBcryptCost(bcrypt.MinCost))
	require.NoError(t, err)
	require.NoError(t, svc.EnsureUser(t.Context(), "jent"))

	mgr := newTestFleet(t)
	runner := &scriptRunner{session: "01APIFAKESESSION0", watched: make(chan struct{})}
	env := &schedEnv{
		sched:  sched.New(sched.Options{Store: st, Runner: runner, Tick: 20 * time.Millisecond}),
		runner: runner,
		store:  st,
		dir:    t.TempDir(),
	}
	server := httptest.NewServer(Handler(Config{
		Auth:  svc,
		Fleet: mgr,
		Sched: env.sched,
		Log:   testLogger(),
	}))
	t.Cleanup(server.Close)
	env.server = server

	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	client := &http.Client{Jar: jar}
	bootstrapAndLogin(t, client, server.URL)
	return env, client
}

// createJob posts one valid interval job and returns its stored row.
func (env *schedEnv) createJob(t *testing.T, client *http.Client, name string, mutate map[string]any) store.Job {
	t.Helper()
	body := map[string]any{
		"name":            name,
		"workspace":       env.dir,
		"scheduleKind":    store.ScheduleInterval,
		"intervalSeconds": 3600,
	}
	for k, v := range mutate {
		body[k] = v
	}
	code, got := callJSON[store.Job](t, client, env.server.URL, http.MethodPost, "/api/jobs", body)
	require.Equal(t, http.StatusCreated, code)
	return got
}

// waitForRun polls until one run row reaches a terminal status.
func (env *schedEnv) waitForRun(t *testing.T, client *http.Client, id int64, status string) store.Run {
	t.Helper()
	var hit store.Run
	require.Eventually(t, func() bool {
		run, ok := env.runByID(t, client, id)
		if !ok || run.Status != status {
			return false
		}
		hit = run
		return true
	}, 3*time.Second, 10*time.Millisecond)
	return hit
}

// runByID fetches one run row through the unfiltered runs listing.
func (env *schedEnv) runByID(t *testing.T, client *http.Client, id int64) (store.Run, bool) {
	t.Helper()
	code, rows := callJSON[[]store.Run](t, client, env.server.URL,
		http.MethodGet, "/api/runs", nil)
	if code != http.StatusOK {
		return store.Run{}, false
	}
	for _, row := range rows {
		if row.ID == id {
			return row, true
		}
	}
	return store.Run{}, false
}

// fireAndWait manually fires a job and waits for it to settle.
func (env *schedEnv) fireAndWait(t *testing.T, client *http.Client, jobID int64) store.Run {
	t.Helper()
	code, run := callJSON[store.Run](t, client, env.server.URL,
		http.MethodPost, "/api/jobs/"+strconv.FormatInt(jobID, 10)+"/run", nil)
	require.Equal(t, http.StatusAccepted, code)
	return env.waitForRun(t, client, run.ID, store.RunOK)
}

// holdLaunches parks every subsequent launch inside the runner.
func (env *schedEnv) holdLaunches(t *testing.T) {
	t.Helper()
	env.runner.mu.Lock()
	env.runner.block = make(chan struct{})
	env.runner.mu.Unlock()
}

// releaseLaunches frees parked launches, safe without any.
func (env *schedEnv) releaseLaunches() {
	env.runner.mu.Lock()
	gate := env.runner.block
	env.runner.block = nil
	env.runner.mu.Unlock()
	if gate != nil {
		close(gate)
	}
}
func TestJobHandlers(t *testing.T) {
	t.Parallel()

	t.Run("job_crud", func(t *testing.T) {
		env, client := newSchedEnv(t)

		t.Run("create_validates_and_schedules", func(t *testing.T) {
			created := env.createJob(t, client, "nightly", map[string]any{"prompt": "sweep"})

			assert.True(t, created.Enabled) // defaulted on create
			assert.Equal(t, "new", created.SpawnMode)
			require.NotNil(t, created.NextRunAt)

			j, err := env.sched.JobByID(t.Context(), created.ID)
			require.NoError(t, err)
			assert.Equal(t, "sweep", j.Prompt)
		})

		t.Run("create_rejects_bad_schedule", func(t *testing.T) {
			code, _ := callJSON[struct{}](t, client, env.server.URL, http.MethodPost,
				"/api/jobs", map[string]any{
					"name":         "broken",
					"workspace":    env.dir,
					"scheduleKind": store.ScheduleOnce, // no next_run_at
				})
			assert.Equal(t, http.StatusBadRequest, code)
		})

		t.Run("create_accepts_disabled_once_without_slot", func(t *testing.T) {
			// only an armed row needs a slot, a parked draft carries none
			created := env.createJob(t, client, "parked", map[string]any{
				"scheduleKind": store.ScheduleOnce,
				"enabled":      false,
			})
			assert.False(t, created.Enabled)
			assert.Nil(t, created.NextRunAt)
		})

		t.Run("create_rejects_missing_workspace", func(t *testing.T) {
			code, _ := callJSON[struct{}](t, client, env.server.URL, http.MethodPost,
				"/api/jobs", map[string]any{
					"name":            "nowhere",
					"workspace":       "/nonexistent-swarm-test",
					"scheduleKind":    store.ScheduleInterval,
					"intervalSeconds": 60,
				})
			assert.Equal(t, http.StatusBadRequest, code)
		})

		t.Run("create_rejects_duplicate_name", func(t *testing.T) {
			env.createJob(t, client, "dup", nil)

			code, _ := callJSON[struct{}](t, client, env.server.URL, http.MethodPost,
				"/api/jobs", map[string]any{
					"name":            "dup",
					"workspace":       env.dir,
					"scheduleKind":    store.ScheduleInterval,
					"intervalSeconds": 60,
				})
			assert.Equal(t, http.StatusConflict, code)
		})

		t.Run("get_lists_and_404s", func(t *testing.T) {
			env.createJob(t, client, "listed", nil)

			code, jobs := callJSON[[]store.Job](t, client, env.server.URL,
				http.MethodGet, "/api/jobs", nil)
			require.Equal(t, http.StatusOK, code)
			assert.NotEmpty(t, jobs)

			code, _ = callJSON[struct{}](t, client, env.server.URL,
				http.MethodGet, "/api/jobs/9999", nil)
			assert.Equal(t, http.StatusNotFound, code)
		})

		t.Run("update_toggles_enabled_without_rescheduling", func(t *testing.T) {
			created := env.createJob(t, client, "toggle", nil)

			code, updated := callJSON[store.Job](t, client, env.server.URL,
				http.MethodPut, "/api/jobs/"+strconv.FormatInt(created.ID, 10),
				map[string]any{
					"name":            created.Name,
					"workspace":       env.dir,
					"scheduleKind":    store.ScheduleInterval,
					"intervalSeconds": 3600,
					"prompt":          "changed",
					"enabled":         false,
				})
			require.Equal(t, http.StatusOK, code)
			assert.False(t, updated.Enabled)
			assert.Nil(t, updated.NextRunAt) // disabled jobs unschedule
			assert.Equal(t, "changed", updated.Prompt)

			j, err := env.sched.JobByID(t.Context(), created.ID)
			require.NoError(t, err)
			assert.False(t, j.Enabled)
		})

		t.Run("update_reschedules_on_schedule_change", func(t *testing.T) {
			created := env.createJob(t, client, "resched", map[string]any{
				"scheduleKind": store.ScheduleDaily,
				"dailyTime":    "09:00",
				"tz":           "UTC",
			})
			require.NotNil(t, created.NextRunAt)

			code, _ := callJSON[store.Job](t, client, env.server.URL,
				http.MethodPut, "/api/jobs/"+strconv.FormatInt(created.ID, 10),
				map[string]any{
					"name":         "resched",
					"workspace":    env.dir,
					"scheduleKind": store.ScheduleDaily,
					"dailyTime":    "18:30", // moved
					"tz":           "UTC",
				})
			require.Equal(t, http.StatusOK, code)

			j, err := env.sched.JobByID(t.Context(), created.ID)
			require.NoError(t, err)
			require.NotNil(t, j.NextRunAt)
			assert.False(t, j.NextRunAt.Equal(*created.NextRunAt))
		})

		t.Run("delete_keeps_runs", func(t *testing.T) {
			created := env.createJob(t, client, "doomed", nil)
			done := env.fireAndWait(t, client, created.ID)

			code, _ := callJSON[struct{}](t, client, env.server.URL,
				http.MethodDelete, "/api/jobs/"+strconv.FormatInt(created.ID, 10), nil)
			assert.Equal(t, http.StatusNoContent, code)

			code, _ = callJSON[struct{}](t, client, env.server.URL,
				http.MethodGet, "/api/jobs/"+strconv.FormatInt(created.ID, 10), nil)
			assert.Equal(t, http.StatusNotFound, code)

			// history survives unlinked: the job filter no longer sees it
			code, runs := callJSON[[]store.Run](t, client, env.server.URL,
				http.MethodGet, "/api/runs", nil)
			require.Equal(t, http.StatusOK, code)
			var kept *store.Run
			for i := range runs {
				if runs[i].ID == done.ID {
					kept = &runs[i]
				}
			}
			require.NotNil(t, kept)
			assert.Nil(t, kept.JobID)
		})
	})

	t.Run("one_shot_re_enable", func(t *testing.T) {
		env, client := newSchedEnv(t)

		// createOnce posts one armed once job due a minute out: far enough to
		// never fire mid-test, near enough to read as a live slot.
		createOnce := func(name string) store.Job {
			slot := time.Now().Add(time.Minute).UTC().Format(time.RFC3339)
			return env.createJob(t, client, name, map[string]any{
				"scheduleKind": store.ScheduleOnce,
				"nextRunAt":    slot,
			})
		}
		// markFired stores the post-claim shape a once fire leaves: the slot
		// cleared, the row still enabled.
		markFired := func(j store.Job) {
			j.NextRunAt = nil
			require.NoError(t, env.store.UpdateJob(t.Context(), j))
		}
		// toggle mirrors the list checkbox: the stored row spread back with
		// enabled flipped, the exact body JobsHome PUTs.
		toggle := func(id int64, enable bool) (int, store.Job) {
			path := "/api/jobs/" + strconv.FormatInt(id, 10)
			code, row := callJSON[map[string]any](t, client, env.server.URL,
				http.MethodGet, path, nil)
			require.Equal(t, http.StatusOK, code)
			row["enabled"] = enable
			return callJSON[store.Job](t, client, env.server.URL,
				http.MethodPut, path, row)
		}

		t.Run("fired_row_disables_without_slot", func(t *testing.T) {
			created := createOnce("fired")
			markFired(created)

			code, updated := toggle(created.ID, false)
			require.Equal(t, http.StatusOK, code)
			assert.False(t, updated.Enabled)
			assert.Nil(t, updated.NextRunAt) // a disabled save needs no slot

			j, err := env.sched.JobByID(t.Context(), created.ID)
			require.NoError(t, err)
			assert.Nil(t, j.NextRunAt)
		})

		t.Run("fired_row_re_enable_arms", func(t *testing.T) {
			created := createOnce("rearmed")
			markFired(created)

			code, updated := toggle(created.ID, true)
			require.Equal(t, http.StatusOK, code)
			assert.True(t, updated.Enabled)
			require.NotNil(t, updated.NextRunAt)
			assert.WithinDuration(t, sched.ReArmOnce(time.Now()), *updated.NextRunAt, time.Minute)

			j, err := env.sched.JobByID(t.Context(), created.ID)
			require.NoError(t, err)
			require.NotNil(t, j.NextRunAt) // stored, not just replied
			assert.WithinDuration(t, sched.ReArmOnce(time.Now()), *j.NextRunAt, time.Minute)
		})

		t.Run("disabled_row_re_enable_arms", func(t *testing.T) {
			created := createOnce("cycle")

			// disabling clears the slot, so enabling starts from slotless too
			code, off := toggle(created.ID, false)
			require.Equal(t, http.StatusOK, code)
			assert.Nil(t, off.NextRunAt)

			code, on := toggle(created.ID, true)
			require.Equal(t, http.StatusOK, code)
			assert.True(t, on.Enabled)
			require.NotNil(t, on.NextRunAt)
			assert.WithinDuration(t, sched.ReArmOnce(time.Now()), *on.NextRunAt, time.Minute)
		})

		t.Run("explicit_slot_survives_re_enable", func(t *testing.T) {
			created := createOnce("edited")
			markFired(created)

			// the editor's save carries its own picked fire time, which wins
			// over the list toggle's auto-arm
			slot := time.Now().Add(3 * time.Hour).UTC().Truncate(time.Second)
			code, updated := callJSON[store.Job](t, client, env.server.URL,
				http.MethodPut, "/api/jobs/"+strconv.FormatInt(created.ID, 10),
				map[string]any{
					"name":         "edited",
					"workspace":    env.dir,
					"scheduleKind": store.ScheduleOnce,
					"nextRunAt":    slot.Format(time.RFC3339),
					"enabled":      true,
				})
			require.Equal(t, http.StatusOK, code)
			require.NotNil(t, updated.NextRunAt)
			assert.True(t, updated.NextRunAt.Equal(slot))
		})
	})

	t.Run("manual_fire_endpoint", func(t *testing.T) {
		env, client := newSchedEnv(t)

		created := env.createJob(t, client, "fired", map[string]any{
			"prompt":  "do it now",
			"enabled": false, // disabled jobs fire manually
		})

		t.Run("fires_disabled_job", func(t *testing.T) {
			code, run := callJSON[store.Run](t, client, env.server.URL,
				http.MethodPost, "/api/jobs/"+strconv.FormatInt(created.ID, 10)+"/run", nil)
			require.Equal(t, http.StatusAccepted, code)
			assert.Equal(t, store.TriggerManual, run.Trigger)

			done := env.waitForRun(t, client, run.ID, store.RunOK)
			assert.NotEmpty(t, done.SessionID)
		})

		t.Run("overlap_refuses_with_conflict", func(t *testing.T) {
			// flip the policy to skip-if-running and park a fire in its launch
			code, _ := callJSON[store.Job](t, client, env.server.URL,
				http.MethodPut, "/api/jobs/"+strconv.FormatInt(created.ID, 10),
				map[string]any{
					"name":            created.Name,
					"workspace":       env.dir,
					"scheduleKind":    store.ScheduleInterval,
					"intervalSeconds": 3600,
					"enabled":         false,
					"overlap":         store.OverlapSkipIfRunning,
				})
			require.Equal(t, http.StatusOK, code)

			env.holdLaunches(t)
			code, live := callJSON[store.Run](t, client, env.server.URL,
				http.MethodPost, "/api/jobs/"+strconv.FormatInt(created.ID, 10)+"/run", nil)
			require.Equal(t, http.StatusAccepted, code)

			code, _ = callJSON[struct{}](t, client, env.server.URL,
				http.MethodPost, "/api/jobs/"+strconv.FormatInt(created.ID, 10)+"/run", nil)
			assert.Equal(t, http.StatusConflict, code)

			env.releaseLaunches()
			env.waitForRun(t, client, live.ID, store.RunOK)
		})

		t.Run("unknown_job_is_404", func(t *testing.T) {
			code, _ := callJSON[struct{}](t, client, env.server.URL,
				http.MethodPost, "/api/jobs/9999/run", nil)
			assert.Equal(t, http.StatusNotFound, code)
		})
	})

	t.Run("runs_listing_endpoint", func(t *testing.T) {
		env, client := newSchedEnv(t)

		a := env.createJob(t, client, "job-a", nil)
		b := env.createJob(t, client, "job-b", nil)
		env.fireAndWait(t, client, a.ID)
		env.fireAndWait(t, client, b.ID)
		env.fireAndWait(t, client, a.ID)

		t.Run("lists_newest_first", func(t *testing.T) {
			code, runs := callJSON[[]store.Run](t, client, env.server.URL,
				http.MethodGet, "/api/runs", nil)
			require.Equal(t, http.StatusOK, code)
			require.Len(t, runs, 3)
			assert.Greater(t, runs[0].ID, runs[2].ID)
		})

		t.Run("filters_by_job", func(t *testing.T) {
			code, runs := callJSON[[]store.Run](t, client, env.server.URL,
				http.MethodGet, "/api/runs?job="+strconv.FormatInt(a.ID, 10), nil)
			require.Equal(t, http.StatusOK, code)
			require.Len(t, runs, 2)
			for _, r := range runs {
				require.NotNil(t, r.JobID)
				assert.Equal(t, a.ID, *r.JobID)
			}
		})

		t.Run("limit_bounds_the_page", func(t *testing.T) {
			code, runs := callJSON[[]store.Run](t, client, env.server.URL,
				http.MethodGet, "/api/runs?limit=1", nil)
			require.Equal(t, http.StatusOK, code)
			assert.Len(t, runs, 1)

			code, _ = callJSON[struct{}](t, client, env.server.URL,
				http.MethodGet, "/api/runs?limit=nope", nil)
			assert.Equal(t, http.StatusBadRequest, code)
		})

		t.Run("bad_job_filter_is_400", func(t *testing.T) {
			code, _ := callJSON[struct{}](t, client, env.server.URL,
				http.MethodGet, "/api/runs?job=abc", nil)
			assert.Equal(t, http.StatusBadRequest, code)
		})
	})

	t.Run("queue_endpoint", func(t *testing.T) {
		env, client := newSchedEnv(t)

		queue := func(mutate map[string]any) (int, store.Job) {
			t.Helper()
			body := map[string]any{
				"name":      "someday",
				"workspace": env.dir,
				"prompt":    "review the diff",
			}
			for k, v := range mutate {
				body[k] = v
			}
			code, got := callJSON[store.Job](t, client, env.server.URL,
				http.MethodPost, "/api/jobs/queue", body)
			return code, got
		}

		t.Run("creates_fixed_shape_row", func(t *testing.T) {
			code, created := queue(map[string]any{
				"model":          "p/m",
				"permission":     "allow-all",
				"toolsCustom":    true,
				"tools":          "builtin:read",
				"triggerCommand": "git pull --ff-only",
			})
			require.Equal(t, http.StatusCreated, code)

			assert.True(t, created.Queued)
			assert.True(t, created.Enabled)
			assert.Equal(t, store.ScheduleOnce, created.ScheduleKind)
			assert.Equal(t, "new", created.SpawnMode)
			assert.True(t, created.RunWhenIdle)
			assert.Zero(t, created.IdleMaxDelaySeconds) // waits forever, never skips
			assert.True(t, created.KeepAlive)           // the session survives the run
			require.NotNil(t, created.NextRunAt)        // due at once
			assert.Equal(t, "p/m", created.Model)
			assert.Equal(t, "allow-all", created.Permission)
			assert.True(t, created.ToolsCustom)
			assert.Equal(t, "builtin:read", created.Tools)
			assert.Equal(t, "git pull --ff-only", created.TriggerCommand)

			// the scheduler never started, so the row sits waiting exactly as
			// the queue means it to
			j, err := env.sched.JobByID(t.Context(), created.ID)
			require.NoError(t, err)
			assert.True(t, j.Queued)
		})

		t.Run("prompt_is_required", func(t *testing.T) {
			code, _ := queue(map[string]any{"prompt": "   "})
			assert.Equal(t, http.StatusBadRequest, code)
		})

		t.Run("name_is_required", func(t *testing.T) {
			code, _ := queue(map[string]any{"name": ""})
			assert.Equal(t, http.StatusBadRequest, code)
		})

		t.Run("workspace_must_exist", func(t *testing.T) {
			code, _ := queue(map[string]any{"workspace": "/nonexistent-swarm-test"})
			assert.Equal(t, http.StatusBadRequest, code)
		})

		t.Run("unknown_field_rejected", func(t *testing.T) {
			// the body is strict: schedule shaping belongs to the full editor
			code, _ := queue(map[string]any{"scheduleKind": "interval"})
			assert.Equal(t, http.StatusBadRequest, code)
		})

		t.Run("duplicate_name_conflicts", func(t *testing.T) {
			code, _ := queue(map[string]any{"name": "taken"})
			require.Equal(t, http.StatusCreated, code)

			code, _ = queue(map[string]any{"name": "taken"})
			assert.Equal(t, http.StatusConflict, code)

			// and against an ordinary job's name too
			env.createJob(t, client, "plain", nil)
			code, _ = queue(map[string]any{"name": "plain"})
			assert.Equal(t, http.StatusConflict, code)
		})

		t.Run("update_preserves_the_marker", func(t *testing.T) {
			// an editor edit that omits the flag cannot un-queue the row, and the
			// wait keeps its anchor even when the slot rides nowhere
			code, created := queue(map[string]any{"name": "editme"})
			require.Equal(t, http.StatusCreated, code)
			require.NotNil(t, created.NextRunAt)

			code, updated := callJSON[store.Job](t, client, env.server.URL,
				http.MethodPut, "/api/jobs/"+strconv.FormatInt(created.ID, 10),
				map[string]any{
					"name":      "editme",
					"workspace": env.dir,
					"prompt":    "changed",
				})
			require.Equal(t, http.StatusOK, code)
			assert.True(t, updated.Queued)
			assert.Equal(t, "changed", updated.Prompt)
			require.NotNil(t, updated.NextRunAt)
			assert.True(t, updated.NextRunAt.Equal(*created.NextRunAt))
		})

		t.Run("re_enabled_queue_restarts_wait", func(t *testing.T) {
			code, created := queue(map[string]any{"name": "requeue"})
			require.Equal(t, http.StatusCreated, code)

			// disabling unschedules like any other row
			code, off := callJSON[store.Job](t, client, env.server.URL,
				http.MethodPut, "/api/jobs/"+strconv.FormatInt(created.ID, 10),
				map[string]any{"name": "requeue", "workspace": env.dir,
					"prompt": "review the diff", "enabled": false,
					"nextRunAt": created.NextRunAt})
			require.Equal(t, http.StatusOK, code)
			assert.Nil(t, off.NextRunAt)

			// re-enabling without a slot restarts the idle wait instead of 400ing
			code, on := callJSON[store.Job](t, client, env.server.URL,
				http.MethodPut, "/api/jobs/"+strconv.FormatInt(created.ID, 10),
				map[string]any{"name": "requeue", "workspace": env.dir,
					"prompt": "review the diff", "enabled": true})
			require.Equal(t, http.StatusOK, code)
			assert.True(t, on.Queued)
			require.NotNil(t, on.NextRunAt)
		})
	})

	t.Run("parameterized_route_falls_to_json_404", func(t *testing.T) {
		env, client := newSchedEnv(t)

		// parameterized paths have no literal key in the method table and fall
		// through to the JSON 404, like every other {id} route
		code, _ := callJSON[struct{}](t, client, env.server.URL,
			http.MethodPatch, "/api/jobs/1", nil)
		assert.Equal(t, http.StatusNotFound, code)
	})

	t.Run("preview_endpoint", func(t *testing.T) {
		env, client := newSchedEnv(t)

		t.Run("interval_slots_march", func(t *testing.T) {
			before := time.Now().UTC()
			code, got := callJSON[schedulePreview](t, client, env.server.URL,
				http.MethodPost, "/api/jobs/preview", map[string]any{
					"scheduleKind":    store.ScheduleInterval,
					"intervalSeconds": 1800,
				})
			require.Equal(t, http.StatusOK, code)
			require.Len(t, got.Times, 3) // the editor's default

			for i, want := range []int64{1, 2, 3} {
				slot := got.Times[i].UTC()
				assert.WithinDuration(t,
					before.Add(time.Duration(want)*30*time.Minute), slot, 5*time.Second)
			}
		})

		t.Run("daily_resolves_in_zone", func(t *testing.T) {
			code, got := callJSON[schedulePreview](t, client, env.server.URL,
				http.MethodPost, "/api/jobs/preview", map[string]any{
					"scheduleKind": store.ScheduleDaily,
					"dailyTime":    "09:00",
					"tz":           "UTC",
				})
			require.Equal(t, http.StatusOK, code)
			require.Len(t, got.Times, 3)

			for _, slot := range got.Times {
				utc := slot.UTC()
				assert.Equal(t, "09:00", utc.Format("15:04"))
			}
			require.Equal(t, 24*time.Hour, got.Times[1].Sub(got.Times[0]))
		})

		t.Run("count_is_clamped", func(t *testing.T) {
			code, got := callJSON[schedulePreview](t, client, env.server.URL,
				http.MethodPost, "/api/jobs/preview", map[string]any{
					"scheduleKind":    store.ScheduleInterval,
					"intervalSeconds": 60,
					"count":           10_000,
				})
			require.Equal(t, http.StatusOK, code)
			assert.Len(t, got.Times, maxPreviewSlots)
		})

		t.Run("invalid_schedule_is_400", func(t *testing.T) {
			code, _ := callJSON[struct{}](t, client, env.server.URL,
				http.MethodPost, "/api/jobs/preview", map[string]any{
					"scheduleKind": store.ScheduleDaily,
					"dailyTime":    "25:00",
				})
			assert.Equal(t, http.StatusBadRequest, code)
		})

		t.Run("workspace_check_rides_along", func(t *testing.T) {
			code, ok := callJSON[schedulePreview](t, client, env.server.URL,
				http.MethodPost, "/api/jobs/preview", map[string]any{
					"scheduleKind":    store.ScheduleInterval,
					"intervalSeconds": 60,
					"workspace":       env.dir,
				})
			require.Equal(t, http.StatusOK, code)
			assert.Empty(t, ok.WorkspaceError)

			code, bad := callJSON[schedulePreview](t, client, env.server.URL,
				http.MethodPost, "/api/jobs/preview", map[string]any{
					"scheduleKind":    store.ScheduleInterval,
					"intervalSeconds": 60,
					"workspace":       "/nonexistent-swarm-test",
				})
			require.Equal(t, http.StatusOK, code)
			assert.Contains(t, bad.WorkspaceError, "workspace")
		})
	})

	t.Run("empty_lists_encode_arrays", func(t *testing.T) {
		// run history with nothing recorded must answer [] not null: the UI's
		// filter selects and table renders read plain arrays off these endpoints
		env, client := newSchedEnv(t)

		for _, path := range []string{"/api/runs", "/api/jobs"} {
			resp := call(t, client, env.server.URL, http.MethodGet, path, nil)
			body, err := io.ReadAll(resp.Body)
			require.NoError(t, err)
			assert.Equal(t, http.StatusOK, resp.StatusCode)
			assert.JSONEq(t, "[]", string(body))
		}
	})
}
