//go:build unix

package fleet

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/paths"
)

func TestAdoptMarksDeadAndReadoptsLive(t *testing.T) {
	home, err := os.MkdirTemp("", "adopt")
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	t.Setenv(paths.EnvHome, home)

	ws := launchWorkspace(t, home)
	cs := newFakeChildStore()
	ctx := context.Background()

	// a child that died while the previous service was down
	deadPID := deadPID(t)
	_, err = cs.CreateChild(ctx, ChildRecord{
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
	m.Start(context.Background())
	t.Cleanup(m.Stop)

	t.Run("dead child marked exited", func(t *testing.T) {
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

	t.Run("live orphan readopted as owned", func(t *testing.T) {
		require.Eventually(t, func() bool {
			live, ok := rowFor(m.Sessions(), liveID)
			return ok && live.SpawnedBy == SpawnedBySwarm && live.Argv == "--serve --session daily"
		}, 3*time.Second, testPoll)
	})
}
