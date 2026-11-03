package app

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent-swarm/pkg/testutil"
)

// acquireEventually takes one lock, retrying briefly: under parallel temp-dir
// churn a fresh directory can land on an inode whose flock entry from a just-
// deleted sibling is still being torn down. That ghost clears on its own; a
// genuinely un-released lock never would, so the retry cannot mask a bug.
func acquireEventually(t *testing.T, dir string) *instanceLock {
	t.Helper()
	var lock *instanceLock
	require.Eventually(t, func() bool {
		l, err := acquireInstanceLock(dir)
		if err != nil {
			return false
		}
		lock = l
		return true
	}, 2*time.Second, time.Millisecond)
	return lock
}

func TestAcquireInstanceLock(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	pidPath := filepath.Join(dir, pidFileName)
	require.NoError(t, os.WriteFile(pidPath, []byte("4242\n"), 0o600))

	lock := acquireEventually(t, dir)

	_, err := acquireInstanceLock(dir) // our own held lock: refusal is immediate
	require.ErrorIs(t, err, errLocked)
	assert.Contains(t, err.Error(), "another ajent-swarm instance holds")
	assert.Contains(t, err.Error(), "(pid 4242)", "the holder is named from the pid file")

	// release frees the directory for the next process
	require.NoError(t, lock.Close())
	lock2 := acquireEventually(t, dir)
	t.Cleanup(func() { _ = lock2.Close() })
}

func TestAcquireInstanceLockWithoutPidfile(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	lock := acquireEventually(t, dir)
	t.Cleanup(func() { _ = lock.Close() })

	_, err := acquireInstanceLock(dir)
	require.ErrorIs(t, err, errLocked)
	assert.Contains(t, err.Error(), dir, "the state directory is named even without a pid")
}

func TestAcquireInstanceLockMissingDir(t *testing.T) {
	t.Parallel()

	_, err := acquireInstanceLock(filepath.Join(t.TempDir(), "absent"))
	require.Error(t, err)
	assert.NotErrorIs(t, err, errLocked)
}

func TestWritePidfile(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), pidFileName)
	require.NoError(t, os.WriteFile(path, []byte("99999\n"), 0o600))

	require.NoError(t, writePidfile(path))

	data, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, os.Getpid(), mustAtoi(t, string(data)))
}

func TestRemovePidfile(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), pidFileName)
	removePidfile(path) // already gone is fine

	require.NoError(t, writePidfile(path))
	removePidfile(path)

	_, err := os.Stat(path)
	assert.True(t, os.IsNotExist(err), "pid file removed")
}

func TestEnsureStateDirDefaultUnderAjentHome(t *testing.T) {
	// t.Setenv forbids parallel
	home := testutil.IsolateHome(t)

	dir, warn, err := ensureStateDir("")
	require.NoError(t, err)
	assert.Empty(t, warn)
	assert.Equal(t, filepath.Join(home, swarmDirName), dir)

	fi, err := os.Stat(dir)
	require.NoError(t, err)
	assert.Zero(t, fi.Mode().Perm()&0o077, "owner-only permissions")
}

func TestEnsureStateDirCustom(t *testing.T) {
	t.Parallel()

	custom := filepath.Join(t.TempDir(), "elsewhere", "swarm")
	dir, warn, err := ensureStateDir(custom)
	require.NoError(t, err)
	assert.Equal(t, custom, dir)
	assert.Empty(t, warn)

	fi, err := os.Stat(dir)
	require.NoError(t, err)
	assert.Zero(t, fi.Mode().Perm()&0o077, "owner-only permissions")
}

func TestEnsureStateDirTightensCustom(t *testing.T) {
	t.Parallel()

	custom := filepath.Join(t.TempDir(), "loose")
	require.NoError(t, os.MkdirAll(custom, 0o755))

	dir, warn, err := ensureStateDir(custom)
	require.NoError(t, err)
	assert.Equal(t, custom, dir)
	assert.Contains(t, warn, "group or world accessible")
	assert.Contains(t, warn, "tightened to 0700")

	fi, err := os.Stat(dir)
	require.NoError(t, err)
	assert.Zero(t, fi.Mode().Perm()&0o077, "permissions tightened")
}

// mustAtoi parses a pid file's decimal content.
func mustAtoi(t *testing.T, s string) int {
	t.Helper()
	n, err := strconv.Atoi(strings.TrimSpace(s))
	require.NoError(t, err)
	return n
}
