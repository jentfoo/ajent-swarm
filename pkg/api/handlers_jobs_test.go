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
}

func (r *scriptRunner) Launch(_ context.Context, _ fleet.LaunchRequest) (fleet.LaunchResult, error) {
	r.mu.Lock()
	gate := r.block
	r.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-time.After(5 * time.Second):
		}
	}
	return fleet.LaunchResult{SessionID: r.session}, nil
}

// LastBusyAt reports a quiet fleet; no job in these tests waits for idle.
func (r *scriptRunner) LastBusyAt() time.Time { return time.Time{} }

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
	case <-time.After(5 * time.Second):
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

// mustJSONFrame encodes one stream frame; only unreachable types fail.
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

// releaseLaunches frees parked launches; safe without any.
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
	t.Run("job crud", func(t *testing.T) {
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

		t.Run("delete_removes_job_but_keeps_runs", func(t *testing.T) {
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

	t.Run("manual fire endpoint", func(t *testing.T) {
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

	t.Run("runs listing endpoint", func(t *testing.T) {
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

	t.Run("route rejects wrong method", func(t *testing.T) {
		env, client := newSchedEnv(t)

		code, _ := callJSON[struct{}](t, client, env.server.URL,
			http.MethodPatch, "/api/runs", nil)
		assert.Equal(t, http.StatusMethodNotAllowed, code)

		// parameterized paths have no literal key in the method table and fall
		// through to the JSON 404, like every other {id} route
		code, _ = callJSON[struct{}](t, client, env.server.URL,
			http.MethodPatch, "/api/jobs/1", nil)
		assert.Equal(t, http.StatusNotFound, code)
	})

	t.Run("preview endpoint", func(t *testing.T) {
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

	t.Run("empty lists encode arrays", func(t *testing.T) {
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
