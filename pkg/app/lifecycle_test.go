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

func TestLifecycle(t *testing.T) {
	// not parallel: t.Setenv mutates process state and some cases swap the
	// package stop tunables

	t.Run("resolve pid path", func(t *testing.T) {
		t.Run("state directory next", func(t *testing.T) {
			got, err := resolvePidPath("/state", "")
			require.NoError(t, err)
			assert.Equal(t, "/state/"+pidFileName, got)
		})

		t.Run("default under ajent home", func(t *testing.T) {
			home := testutil.IsolateHome(t)
			got, err := resolvePidPath("", "")
			require.NoError(t, err)
			assert.Equal(t, filepath.Join(home, swarmDirName, pidFileName), got)
			_, statErr := os.Stat(filepath.Join(home, swarmDirName))
			assert.ErrorIs(t, statErr, os.ErrNotExist)
		})
	})

	t.Run("status and stop without pidfile", func(t *testing.T) {
		dir := t.TempDir()

		var out, errOut strings.Builder
		code := Status(dir, "", &out, &errOut)
		assert.Equal(t, 1, code)
		assert.Contains(t, out.String(), "stopped")

		code = Stop(dir, "", &out, &errOut)
		assert.Equal(t, 0, code)
		assert.Contains(t, out.String(), "not running")
	})

	t.Run("stop terminates a running process", func(t *testing.T) {
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
		select {
		case <-waited:
		case <-time.After(2 * time.Second):
			t.Fatal("the signaled process never exited")
		}
		assert.NoFileExists(t, pidPath)
	})

	t.Run("stop stale pidfile", func(t *testing.T) {
		// a pid very unlikely to exist; raised past any wrapped pid until free
		pid := (1 << 22) + 424242
		for i := 0; i < 1000 && (pidAlive(pid) || pid == os.Getpid()); i++ {
			pid++
		}
		require.False(t, pidAlive(pid))

		pidPath := filepath.Join(t.TempDir(), pidFileName)
		require.NoError(t, os.WriteFile(pidPath, []byte(strconv.Itoa(pid)), 0o600))

		var out strings.Builder
		code := Stop("", pidPath, &out, &strings.Builder{})
		assert.Equal(t, 0, code)
		assert.Contains(t, out.String(), "stale")
		assert.NoFileExists(t, pidPath)

		code = Status("", pidPath, &out, &strings.Builder{})
		assert.Equal(t, 1, code)
	})

	t.Run("status running and malformed", func(t *testing.T) {
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
