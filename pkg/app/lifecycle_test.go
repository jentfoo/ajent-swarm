//go:build unix

package app

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent-swarm/pkg/testutil"
)

func TestResolvePidPath(t *testing.T) {
	// not parallel: t.Setenv mutates process state

	t.Run("state_directory_next", func(t *testing.T) {
		got, err := resolvePidPath("/state", "")
		require.NoError(t, err)
		assert.Equal(t, "/state/"+pidFileName, got)
	})

	t.Run("default_under_ajent_home", func(t *testing.T) {
		home := testutil.IsolateHome(t)
		got, err := resolvePidPath("", "")
		require.NoError(t, err)
		assert.Equal(t, filepath.Join(home, swarmDirName, pidFileName), got)
		_, statErr := os.Stat(filepath.Join(home, swarmDirName))
		assert.ErrorIs(t, statErr, os.ErrNotExist)
	})
}

func TestStatus(t *testing.T) {
	t.Run("without_pidfile_reports_stopped", func(t *testing.T) {
		dir := t.TempDir()
		var out, errOut strings.Builder
		code := Status(dir, "", &out, &errOut)
		assert.Equal(t, 1, code)
		assert.Contains(t, out.String(), "stopped")
	})

	t.Run("stale_pidfile_reports_stopped", func(t *testing.T) {
		pid := unlikelyFreePID(t)

		pidPath := filepath.Join(t.TempDir(), pidFileName)
		require.NoError(t, os.WriteFile(pidPath, []byte(strconv.Itoa(pid)), 0o600))

		var out strings.Builder
		code := Status("", pidPath, &out, &strings.Builder{})
		assert.Equal(t, 1, code)
	})

	t.Run("running_and_malformed", func(t *testing.T) {
		pidPath := filepath.Join(t.TempDir(), pidFileName)
		require.NoError(t, os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())), 0o600))

		var out strings.Builder
		code := Status("", pidPath, &out, &strings.Builder{})
		assert.Equal(t, 0, code)
		assert.Contains(t, out.String(), "running")

		require.NoError(t, os.WriteFile(pidPath, []byte("not-a-pid"), 0o600))
		code = Status("", pidPath, &out, &strings.Builder{})
		assert.Equal(t, 1, code)
	})
}

func TestStop(t *testing.T) {
	// not parallel: the terminate case swaps the package stop tunables

	t.Run("without_pidfile_reports_not_running", func(t *testing.T) {
		dir := t.TempDir()
		var out, errOut strings.Builder
		code := Stop(dir, "", &out, &errOut)
		assert.Equal(t, 0, code)
		assert.Contains(t, out.String(), "not running")
	})

	t.Run("terminates_a_running_process", func(t *testing.T) {
		if _, err := exec.LookPath("sleep"); err != nil {
			t.Skip("sleep unavailable")
		}
		cmd := exec.CommandContext(t.Context(), "sleep", "60")
		require.NoError(t, cmd.Start())
		waited := make(chan struct{})
		go func() { _, _ = cmd.Process.Wait(); close(waited) }()
		t.Cleanup(func() {
			_ = cmd.Process.Kill()
			<-waited
		})

		// a short wait keeps the test quick
		prevTerm, prevPoll := stopTermWait, stopPoll
		stopTermWait, stopPoll = 3*time.Second, 10*time.Millisecond
		t.Cleanup(func() { stopTermWait, stopPoll = prevTerm, prevPoll })

		pidPath := filepath.Join(t.TempDir(), pidFileName)
		require.NoError(t, os.WriteFile(pidPath, []byte(strconv.Itoa(cmd.Process.Pid)), 0o600))

		var out, errOut strings.Builder
		code := Stop("", pidPath, &out, &errOut)
		assert.Equal(t, 0, code)
		assert.Contains(t, out.String(), "stopped")
		// Stop reaped the child, so the waiter always closes
		<-waited
		assert.NoFileExists(t, pidPath)
	})

	t.Run("stale_pidfile", func(t *testing.T) {
		pid := unlikelyFreePID(t)

		pidPath := filepath.Join(t.TempDir(), pidFileName)
		require.NoError(t, os.WriteFile(pidPath, []byte(strconv.Itoa(pid)), 0o600))

		var out strings.Builder
		code := Stop("", pidPath, &out, &strings.Builder{})
		assert.Equal(t, 0, code)
		assert.Contains(t, out.String(), "stale")
		assert.NoFileExists(t, pidPath)
	})
}

// unlikelyFreePID picks a pid very unlikely to exist, raised past any wrapped
// pid until free.
func unlikelyFreePID(t *testing.T) int {
	t.Helper()
	pid := (1 << 22) + 424242
	for i := 0; i < 1000 && (pidAlive(pid) || pid == os.Getpid()); i++ {
		pid++
	}
	require.False(t, pidAlive(pid))
	return pid
}
