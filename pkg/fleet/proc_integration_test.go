//go:build unix

package fleet

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent/pkg/client"
	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/paths"
)

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

func TestFleetLaunchIntegration(t *testing.T) {
	bin := os.Getenv(integrationBin)
	if bin == "" {
		t.Skipf("set %s to a built ajent binary to run the launch integration test", integrationBin)
	}
	if _, err := os.Stat(bin); err != nil {
		t.Fatalf("ajent binary %s: %v", bin, err)
	}

	home, err := os.MkdirTemp("", "fleetint")
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	t.Setenv(paths.EnvHome, home)
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
	env.m.Start(context.Background())
	t.Cleanup(env.m.Stop)

	res, err := env.m.Launch(t.Context(), LaunchRequest{Workspace: ws, Mode: LaunchNew})
	require.NoError(t, err)
	require.NotEmpty(t, res.SessionID)
	assert.Equal(t, ws, res.Workspace)

	// the fleet attaches, holds the seat, and the log lives under its name
	require.Eventually(t, func() bool {
		st, ok := rowFor(env.m.Sessions(), res.SessionID)
		return ok && st.State == ChildOnline && st.SpawnedBy == SpawnedBySwarm && st.SeatOurs
	}, 15*time.Second, testPoll)
	_, err = os.Stat(filepath.Join(home, "children",
		res.SessionID+"-"+strconv.Itoa(res.PID)+logSuffix))
	require.NoError(t, err)

	// submit is refused: swarm holds the seat, so an outside controller
	// attaches as an observer and every write answers observer
	assertSubmitRefused(t, res.SessionID, res.PID)

	// the stop path ends the child and reaps it cleanly
	require.NoError(t, env.m.StopSession(t.Context(), res.SessionID))
	require.Eventually(t, func() bool {
		st, ok := rowFor(env.m.Sessions(), res.SessionID)
		return ok && st.State == ChildExited && st.ExitCode != nil && *st.ExitCode == 0
	}, 15*time.Second, testPoll)
	assert.True(t, pidGone(res.PID))

	t.Run("external session joins as external", func(t *testing.T) {
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
}

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
	defer conn.Close()
	assert.Equal(t, sessionID, hello.Session.ID)

	events := make(chan ctl.Event, 64)
	go conn.Serve(func(ev ctl.Event) { events <- ev })

	cctx, cancel := context.WithTimeout(context.Background(), client.CallWait)
	defer cancel()
	err = conn.Submit(cctx, ctl.SubmitParams{Line: "hello"})
	require.Error(t, err)
	var ce *ctl.Error
	require.ErrorAs(t, err, &ce)
	assert.Equal(t, ctl.CodeObserver, ce.Code)
	assert.Equal(t, holderName, ce.Holder) // swarm held the seat
}
