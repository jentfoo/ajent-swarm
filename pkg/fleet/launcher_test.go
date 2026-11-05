//go:build unix

package fleet

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/go-analyze/bulk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent-swarm/pkg/testutil"
	"github.com/jentfoo/ajent/pkg/client"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// fakeChildStore keeps child rows in memory, mirroring the SQLite store's
// contract for launcher tests.
type fakeChildStore struct {
	mu   sync.Mutex
	next int64
	rows map[int64]ChildRecord
}

func newFakeChildStore() *fakeChildStore {
	return &fakeChildStore{rows: make(map[int64]ChildRecord)}
}

func (f *fakeChildStore) CreateChild(_ context.Context, rec ChildRecord) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.next++
	rec.ID = f.next
	if rec.Origin == "" {
		rec.Origin = SpawnedBySwarm
	}
	f.rows[f.next] = rec
	return f.next, nil
}

// CreateChildIfAbsent inserts unless the pid is already recorded, mirroring
// the SQLite store's dedupe for repeated discovery passes.
func (f *fakeChildStore) CreateChildIfAbsent(_ context.Context, rec ChildRecord) (int64, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, row := range f.rows {
		if row.PID == rec.PID {
			return row.ID, false, nil
		}
	}
	f.next++
	rec.ID = f.next
	if rec.Origin == "" {
		rec.Origin = SpawnedBySwarm
	}
	f.rows[f.next] = rec
	return f.next, true, nil
}

func (f *fakeChildStore) UpdateChild(_ context.Context, rec ChildRecord) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.rows[rec.ID]; !ok {
		return fmt.Errorf("no child row %d", rec.ID)
	}
	f.rows[rec.ID] = rec
	return nil
}

func (f *fakeChildStore) Children(_ context.Context) ([]ChildRecord, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := bulk.MapValuesSlice(f.rows)
	slices.SortFunc(out, func(a, b ChildRecord) int { return cmp.Compare(a.ID, b.ID) })
	return out, nil
}

func (f *fakeChildStore) byPID(pid int) (ChildRecord, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, rec := range f.rows {
		if rec.PID == pid {
			return rec, true
		}
	}
	return ChildRecord{}, false
}

// launchEnv bundles what launcher tests need: an isolated ajent home, a stub
// ajent binary and a fast manager wired for launching.
type launchEnv struct {
	m    *Manager
	bin  string
	home string
	cs   *fakeChildStore
}

// stubChildScript stands in for the ajent binary; its behavior follows
// STUB_CHILD_MODE, which tests set before launching.
const stubChildScript = `#!/bin/sh
record() {
  mkdir -p "$(dirname "$STUB_RECORD_FILE")"
  printf '{"sessionID":"%s","socket":"%s","pid":%d,"token":"stubtok"}' \
    "$STUB_SESSION" "$STUB_SOCKET" "$$" > "$STUB_RECORD_FILE"
}
if [ "$STUB_CHILD_MODE" = "serve" ]; then
  record
fi
if [ "$STUB_CHILD_MODE" = "exit" ]; then
  echo "ajent: no model configured" >&2
  exit 3
fi
if [ "$STUB_CHILD_MODE" = "termproof" ]; then
  trap '' TERM
  : > "$STUB_ARMED_FILE"
  record
  sleep 300
  exit 0
fi
exec sleep 300
`

// writeStubBin writes the stub binary and points it at a work directory.
func writeStubBin(t *testing.T, home string) string {
	t.Helper()
	path := filepath.Join(home, "children-bin", "stub-ajent.sh")
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o700))
	require.NoError(t, os.WriteFile(path, []byte(stubChildScript), 0o755))
	return path
}

// newLaunchEnv isolates AJENT_HOME and starts a fast launch-capable manager.
// killOnExit mirrors the shutdown flag: true makes Stop take children down.
func newLaunchEnv(t *testing.T, killOnExit bool) *launchEnv {
	t.Helper()
	home := testutil.IsolateHome(t)

	env := &launchEnv{bin: writeStubBin(t, home), home: home, cs: newFakeChildStore()}
	env.m = New(Options{
		Log:          testLogger(),
		PollInterval: testPoll,
		BackoffBase:  testBackoff,
		BackoffMax:   testBackoffHi,
		AjentBin:     env.bin,
		ChildrenDir:  filepath.Join(home, "children"),
		ChildStore:   env.cs,
		KillOnExit:   killOnExit,
		LaunchWait:   80 * time.Millisecond,
		AwaitPoll:    5 * time.Millisecond, // registry polls stay out of launch timings
		ExitGrace:    40 * time.Millisecond,
		TermGrace:    40 * time.Millisecond,
	})

	env.m.Start(t.Context())
	t.Cleanup(env.m.Stop)
	return env
}

// setStubRecord points the stub's registry write at the record to publish
// when the child starts: a record naming a socket that never serves. Tests
// pick the mode through STUB_CHILD_MODE.
func setStubRecord(t *testing.T, home, sessionID string) {
	t.Helper()
	t.Setenv("STUB_SESSION", sessionID)
	t.Setenv("STUB_SOCKET", filepath.Join(home, "control", sessionID, "missing.sock"))
	t.Setenv("STUB_RECORD_FILE", filepath.Join(home, "control", sessionID, "stubtok.json"))
}

func launchWorkspace(t *testing.T, home string) string {
	t.Helper()
	ws := filepath.Join(home, "workspace")
	require.NoError(t, os.MkdirAll(ws, 0o700))
	return ws
}

// rowFor finds one listing row by session id.
func rowFor(rows []Status, sessionID string) (Status, bool) {
	for _, st := range rows {
		if st.SessionID == sessionID {
			return st, true
		}
	}
	return Status{}, false
}
func TestLauncher(t *testing.T) {
	t.Run("child_exits_before_serving", func(t *testing.T) {
		env := newLaunchEnv(t, false)
		t.Setenv("STUB_CHILD_MODE", "exit")
		ws := launchWorkspace(t, env.home)

		res, err := env.m.Launch(t.Context(), LaunchRequest{Workspace: ws})
		require.ErrorContains(t, err, "exited before serving")
		require.ErrorContains(t, err, "exit status 3")
		require.ErrorContains(t, err, "no model configured") // ajent's own hint from the log
		assert.Empty(t, res.SessionID)

		// the log survived under its pid name, and no session entered the listing
		logs, rerr := os.ReadDir(filepath.Join(env.home, "children"))
		require.NoError(t, rerr)
		require.Len(t, logs, 1)
		assert.Empty(t, env.m.Sessions())
	})

	t.Run("await_deadline_keeps_child_running", func(t *testing.T) {
		env := newLaunchEnv(t, true) // the shutdown flag must take the stray down
		t.Setenv("STUB_CHILD_MODE", "block")
		ws := launchWorkspace(t, env.home)

		_, err := env.m.Launch(t.Context(), LaunchRequest{Workspace: ws})
		require.ErrorContains(t, err, "did not register")

		env.m.mu.Lock()
		var pid int
		for _, cp := range env.m.children {
			pid = cp.rec.PID
		}
		env.m.mu.Unlock()
		require.Positive(t, pid)
		assert.False(t, pidGone(pid)) // still running past the deadline

		env.m.Stop()
		assert.True(t, pidGone(pid))
	})

	t.Run("adopts_record_and_stops", func(t *testing.T) {
		env := newLaunchEnv(t, false)
		const sid = "01STUBSERVE0000001"
		t.Setenv("STUB_CHILD_MODE", "serve")
		setStubRecord(t, env.home, sid)
		ws := launchWorkspace(t, env.home)

		res, err := env.m.Launch(t.Context(), LaunchRequest{Workspace: ws})
		require.NoError(t, err)
		assert.Equal(t, sid, res.SessionID)
		assert.Equal(t, ws, res.Workspace)
		assert.Positive(t, res.PID)

		// the log moved to a name carrying the session id
		_, err = os.Stat(filepath.Join(env.home, "children", sid+"-"+strconv.Itoa(res.PID)+logSuffix))
		require.NoError(t, err)

		// the fleet attaches it and marks it ours
		require.Eventually(t, func() bool {
			st, ok := rowFor(env.m.Sessions(), sid)
			return ok && st.SpawnedBy == SpawnedBySwarm && st.Argv != "" && st.PID == res.PID
		}, 3*time.Second, testPoll)

		// stopping ends the child and reaps it in the listing
		require.NoError(t, env.m.StopSession(t.Context(), sid))
		require.Eventually(t, func() bool {
			st, ok := rowFor(env.m.Sessions(), sid)
			return ok && st.State == ChildExited && st.ExitCode != nil
		}, 3*time.Second, testPoll)

		rec, ok := env.cs.byPID(res.PID)
		require.True(t, ok)
		assert.Equal(t, sid, rec.SessionID)
		assert.False(t, rec.ExitedAt.IsZero())
		require.NotNil(t, rec.ExitCode)
		assert.Equal(t, -1, *rec.ExitCode) // SIGTERM ended it
	})

	t.Run("children_outlive_and_readopt", func(t *testing.T) {
		env := newLaunchEnv(t, false) // the default: children outlive the manager
		const sid = "01STUBORPHAN00001"
		t.Setenv("STUB_CHILD_MODE", "serve")
		setStubRecord(t, env.home, sid)
		ws := launchWorkspace(t, env.home)

		res, err := env.m.Launch(t.Context(), LaunchRequest{Workspace: ws})
		require.NoError(t, err)

		env.m.Stop() // the plain shutdown never touches children
		assert.False(t, pidGone(res.PID))

		// a restarted service re-adopts the orphan through the persisted rows
		env2 := &launchEnv{bin: env.bin, home: env.home, cs: env.cs}
		env2.m = New(Options{
			Log:          testLogger(),
			PollInterval: testPoll,
			BackoffBase:  testBackoff,
			BackoffMax:   testBackoffHi,
			AjentBin:     env2.bin,
			ChildrenDir:  filepath.Join(env2.home, "children"),
			ChildStore:   env2.cs,
			KillOnExit:   true,
		})
		env2.m.Start(t.Context())
		t.Cleanup(env2.m.Stop)

		require.Eventually(t, func() bool {
			st, ok := rowFor(env2.m.Sessions(), sid)
			return ok && st.SpawnedBy == SpawnedBySwarm && st.PID == res.PID
		}, 3*time.Second, testPoll)

		// the adopted child stops like any other
		require.NoError(t, env2.m.StopSession(t.Context(), sid))
		require.Eventually(t, func() bool { return pidGone(res.PID) }, 3*time.Second, testPoll)
		rec, ok := env.cs.byPID(res.PID)
		require.True(t, ok)
		assert.Equal(t, "stopped by swarm", rec.ExitNote)
	})

	t.Run("sessions_spawned_by_external", func(t *testing.T) {
		env := newLaunchEnv(t, false)
		stub := fleettest.New(t, env.home, fleettest.Options{SessionID: "01STUBEXT00000001"})
		stub.WriteRegistry(t, os.Getpid(), time.Now())

		require.Eventually(t, func() bool {
			st, ok := rowFor(env.m.Sessions(), stub.SessionID())
			return ok && st.SpawnedBy == SpawnedByExternal && st.State == ChildOnline
		}, 3*time.Second, testPoll)
	})

	t.Run("stop_escalates_to_kill", func(t *testing.T) {
		env := newLaunchEnv(t, false)
		const sid = "01STUBTERM00000001"
		t.Setenv("STUB_CHILD_MODE", "termproof") // TERM cannot stop this one
		t.Setenv("STUB_ARMED_FILE", filepath.Join(env.home, "armed"))
		setStubRecord(t, env.home, sid)
		ws := launchWorkspace(t, env.home)

		// the launch answers only because the trap armed before the record: the
		// session never serves, so stopping it must reach the signals
		res, err := env.m.Launch(t.Context(), LaunchRequest{Workspace: ws})
		require.NoError(t, err)

		require.NoError(t, env.m.StopSession(t.Context(), sid))
		assert.True(t, pidGone(res.PID))

		// the exit note proves the escalation: TERM was trapped, KILL landed
		rec, ok := env.cs.byPID(res.PID)
		require.True(t, ok)
		require.NotNil(t, rec.ExitCode)
		assert.Equal(t, -1, *rec.ExitCode)
		assert.Equal(t, "signal: killed", rec.ExitNote)
	})

	t.Run("stop_unknown_session", func(t *testing.T) {
		env := newLaunchEnv(t, false)
		err := env.m.StopSession(t.Context(), "01NOPE")
		require.ErrorIs(t, err, ErrUnknownSession)
	})

	t.Run("launch_not_configured", func(t *testing.T) {
		testutil.IsolateHome(t)
		m := New(Options{Log: testLogger(), Discover: func() ([]ctl.Instance, error) { return nil, nil }})
		m.Start(t.Context())
		t.Cleanup(m.Stop)

		_, err := m.Launch(t.Context(), LaunchRequest{Workspace: t.TempDir()})
		require.ErrorContains(t, err, "launching is not configured")
	})
	t.Run("adopt_dead_readopt_live", func(t *testing.T) {
		home := testutil.IsolateHome(t)

		ws := launchWorkspace(t, home)
		cs := newFakeChildStore()
		ctx := t.Context()

		// a child that died while the previous service was down
		deadPID := deadPID(t)
		_, err := cs.CreateChild(ctx, ChildRecord{
			PID: deadPID, SessionID: "01ADOPTDEAD0000001", Workspace: ws,
			Argv: "--serve", LogPath: filepath.Join(home, "children", "dead.log"),
			StartedAt: time.Now().Add(-time.Hour),
		})
		require.NoError(t, err)

		// a child still running: the test process stands in for it
		liveID := "01ADOPTLIVE00000001"
		_, err = cs.CreateChild(ctx, ChildRecord{
			PID: os.Getpid(), SessionID: liveID, Workspace: ws,
			Argv: "--serve --session daily", LogPath: filepath.Join(home, "children", "live.log"),
			StartedAt: time.Now().Add(-time.Hour),
		})
		require.NoError(t, err)

		// its registry record, pointing at a socket that never serves
		rec, err := json.Marshal(ctl.Instance{
			SessionID: liveID, Workspace: ws, PID: os.Getpid(),
			Token: "adopttok", Socket: filepath.Join(home, "control", liveID, "missing.sock"),
		})
		require.NoError(t, err)
		dir := filepath.Join(home, "control", liveID)
		require.NoError(t, os.MkdirAll(dir, 0o700))
		require.NoError(t, os.WriteFile(filepath.Join(dir, "adopttok.json"), rec, 0o600))

		m := New(Options{
			Log:          testLogger(),
			PollInterval: testPoll,
			BackoffBase:  testBackoff,
			BackoffMax:   testBackoffHi,
			AjentBin:     writeStubBin(t, home),
			ChildrenDir:  filepath.Join(home, "children"),
			ChildStore:   cs,
		})
		m.Start(t.Context())
		t.Cleanup(m.Stop)

		t.Run("dead_child_marked_exited", func(t *testing.T) {
			require.Eventually(t, func() bool {
				_, ok := rowFor(m.Sessions(), "01ADOPTDEAD0000001")
				return ok
			}, 3*time.Second, testPoll)
			dead, ok := rowFor(m.Sessions(), "01ADOPTDEAD0000001")
			require.True(t, ok)
			assert.Equal(t, ChildExited, dead.State)
			assert.Equal(t, "not running when the service started", dead.Detail)
			assert.Equal(t, SpawnedBySwarm, dead.SpawnedBy)

			row, ok := cs.byPID(deadPID)
			require.True(t, ok)
			assert.Equal(t, "not running when the service started", row.ExitNote)
		})

		t.Run("live_orphan_readopted_as_owned", func(t *testing.T) {
			require.Eventually(t, func() bool {
				live, ok := rowFor(m.Sessions(), liveID)
				return ok && live.SpawnedBy == SpawnedBySwarm && live.Argv == "--serve --session daily"
			}, 3*time.Second, testPoll)
		})
	})

	t.Run("launch_integration", func(t *testing.T) {
		bin := os.Getenv(integrationBin)
		if bin == "" {
			t.Skipf("set %s to a built ajent binary to run the launch integration test", integrationBin)
		}
		if _, err := os.Stat(bin); err != nil {
			t.Fatalf("ajent binary %s: %v", bin, err)
		}

		home := testutil.IsolateHome(t)
		require.NoError(t, os.WriteFile(filepath.Join(home, "models.json"), []byte(integrationModels), 0o600))

		ws := filepath.Join(home, "workspace")
		require.NoError(t, os.MkdirAll(ws, 0o700))

		env := &launchEnv{bin: bin, home: home, cs: newFakeChildStore()}
		env.m = New(Options{
			Log:          testLogger(),
			PollInterval: testPoll,
			BackoffBase:  testBackoff,
			BackoffMax:   testBackoffHi,
			AjentBin:     bin,
			ChildrenDir:  filepath.Join(home, "children"),
			ChildStore:   env.cs,
		})
		env.m.Start(t.Context())
		t.Cleanup(env.m.Stop)

		var res LaunchResult
		t.Run("launch_attaches_and_holds_seat", func(t *testing.T) {
			out, err := env.m.Launch(t.Context(), LaunchRequest{Workspace: ws, Mode: LaunchNew})
			require.NoError(t, err)
			require.NotEmpty(t, out.SessionID)
			assert.Equal(t, ws, out.Workspace)
			res = out

			// the fleet attaches, holds the seat, and the log lives under its name
			require.Eventually(t, func() bool {
				st, ok := rowFor(env.m.Sessions(), res.SessionID)
				return ok && st.State == ChildOnline && st.SpawnedBy == SpawnedBySwarm && st.SeatOurs
			}, 15*time.Second, testPoll)
			_, err = os.Stat(filepath.Join(home, "children",
				res.SessionID+"-"+strconv.Itoa(res.PID)+logSuffix))
			require.NoError(t, err)
		})

		t.Run("observer_submit_is_refused", func(t *testing.T) {
			// submit is refused: swarm holds the seat, so an outside controller
			// attaches as an observer and every write answers observer
			assertSubmitRefused(t, res.SessionID, res.PID)
		})

		t.Run("stop_exits_and_reaps", func(t *testing.T) {
			// the stop path ends the child and reaps it cleanly
			require.NoError(t, env.m.StopSession(t.Context(), res.SessionID))
			require.Eventually(t, func() bool {
				st, ok := rowFor(env.m.Sessions(), res.SessionID)
				return ok && st.State == ChildExited && st.ExitCode != nil && *st.ExitCode == 0
			}, 15*time.Second, testPoll)
			assert.True(t, pidGone(res.PID))
		})

		t.Run("external_session_joins_as_external", func(t *testing.T) {
			cmd := exec.Command(bin, "--serve") //nolint:noctx // the test owns the process lifetime directly
			cmd.Dir = ws
			require.NoError(t, cmd.Start())
			// the test owns the process, so only a reap turns its exit visible
			// to signal zero; one waiter reaps it for every check here
			waited := make(chan struct{})
			go func() {
				_, _ = cmd.Process.Wait()
				close(waited)
			}()
			t.Cleanup(func() {
				_ = cmd.Process.Kill()
				<-waited
			})

			var sid string
			require.Eventually(t, func() bool {
				live, err := client.DiscoverLive()
				if err != nil {
					return false
				}
				for _, in := range live {
					if in.PID == cmd.Process.Pid {
						sid = in.SessionID
						return true
					}
				}
				return false
			}, 15*time.Second, testPoll)

			require.Eventually(t, func() bool {
				st, ok := rowFor(env.m.Sessions(), sid)
				return ok && st.SpawnedBy == SpawnedByExternal && st.State == ChildOnline
			}, 15*time.Second, testPoll)

			// an external session ends through /exit alone
			require.NoError(t, env.m.StopSession(t.Context(), sid))
			require.Eventually(t, func() bool {
				select {
				case <-waited:
					return true
				default:
				}
				return pidGone(cmd.Process.Pid)
			}, 15*time.Second, testPoll)
		})
	})
}

// integrationBin names the env var holding a built ajent binary for the
// phase 04 integration tests; unit runs stay hermetic without it.
const integrationBin = "AJENT_SWARM_TEST_AJENT"

// integrationModels seeds a minimal provider so ajent serve starts without
// walking a human through provider setup.
const integrationModels = `{
  "version": 1,
  "providers": {
    "testprov": {
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:1/v1",
      "apiKey": "dummy",
      "models": [{"id": "test-model", "contextWindow": 8192}]
    }
  }
}
`

// assertSubmitRefused dials the child's control socket the way any outside
// controller would and checks that swarm's seat blocks writes.
func assertSubmitRefused(t *testing.T, sessionID string, pid int) {
	t.Helper()
	live, err := client.DiscoverLive()
	require.NoError(t, err)
	var socket string
	for _, in := range live {
		if in.PID == pid {
			socket = in.Socket
		}
	}
	require.NotEmpty(t, socket)

	conn, hello, err := client.Dial(socket)
	require.NoError(t, err)
	t.Cleanup(conn.Close)
	assert.Equal(t, sessionID, hello.Session.ID)

	events := make(chan ctl.Event, 64)
	go conn.Serve(func(ev ctl.Event) { events <- ev })

	cctx, cancel := context.WithTimeout(t.Context(), client.CallWait)
	err = conn.Submit(cctx, ctl.SubmitParams{Line: "hello"})
	cancel()
	require.Error(t, err)
	var ce *ctl.Error
	require.ErrorAs(t, err, &ce)
	assert.Equal(t, ctl.CodeObserver, ce.Code)
	assert.Equal(t, holderName, ce.Holder) // swarm held the seat
}
