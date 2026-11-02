package app

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAcquireInstanceLock(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	pidPath := filepath.Join(dir, pidFileName)
	require.NoError(t, os.WriteFile(pidPath, []byte("4242\n"), 0o600))

	lock, err := acquireInstanceLock(dir)
	require.NoError(t, err)

	_, err = acquireInstanceLock(dir)
	require.ErrorIs(t, err, errLocked)
	assert.Contains(t, err.Error(), "another ajent-swarm instance holds")
	assert.Contains(t, err.Error(), "(pid 4242)", "the holder is named from the pid file")

	// release frees the directory for the next process
	require.NoError(t, lock.Close())
	lock2, err := acquireInstanceLock(dir)
	require.NoError(t, err)
	t.Cleanup(func() { _ = lock2.Close() })
}

func TestAcquireInstanceLockWithoutPidfile(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	lock, err := acquireInstanceLock(dir)
	require.NoError(t, err)
	t.Cleanup(func() { _ = lock.Close() })

	_, err = acquireInstanceLock(dir)
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
	home := t.TempDir()
	t.Setenv("AJENT_HOME", home)

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
