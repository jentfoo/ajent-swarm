package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/jentfoo/ajent/pkg/paths"
)

// errLocked marks a state directory another process already holds.
var errLocked = errors.New("state directory is locked")

// instanceLock pins the state directory to this process for its lifetime, so
// two swarm instances never fight over children, sockets or SQLite.
type instanceLock struct {
	f *os.File
}

// acquireInstanceLock flocks dir exclusively. A busy lock reports an error
// naming the current holder read from the default pid file inside it.
func acquireInstanceLock(dir string) (*instanceLock, error) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, fmt.Errorf("open state directory %s: %w", dir, err)
	}
	if err = lockFile(f); err != nil {
		_ = f.Close()
		if errors.Is(err, errLocked) {
			return nil, fmt.Errorf(
				"%w: another ajent-swarm instance holds %s%s; stop it or choose another --state",
				errLocked, dir, holderDescription(dir))
		}
		return nil, fmt.Errorf("lock state directory %s: %w", dir, err)
	}
	return &instanceLock{f: f}, nil
}

// Close releases the lock.
func (l *instanceLock) Close() error {
	return l.f.Close()
}

// holderDescription describes the pid file's recorded process, or an empty
// string when there is nothing readable to name. Only the default pid file
// location inside dir is consulted.
func holderDescription(dir string) string {
	data, err := os.ReadFile(filepath.Join(dir, pidFileName))
	if err != nil {
		return ""
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return ""
	}
	return fmt.Sprintf(" (pid %d)", pid)
}

// ensureStateDir creates the state directory when missing and tightens its
// permissions, reporting what changed. The default resolves beside ajent's own
// data through paths.SubDir so both share one tightening behavior.
func ensureStateDir(state string) (dir string, warn string, err error) {
	if state == "" {
		return paths.SubDir(swarmDirName)
	}
	dir = state
	if !filepath.IsAbs(dir) {
		if dir, err = filepath.Abs(dir); err != nil {
			return "", "", fmt.Errorf("resolve --state %s: %w", state, err)
		}
	}
	if err = os.MkdirAll(dir, paths.DirPerm); err != nil {
		return "", "", fmt.Errorf("create state directory %s: %w", dir, err)
	}
	return dir, tightenDir(dir), nil
}

// tightenDir pins dir to ajent's owner-only mode and describes the change,
// mirroring what paths.SubDir reports for its own directories.
func tightenDir(dir string) string {
	if runtime.GOOS == "windows" {
		return ""
	}
	fi, err := os.Stat(dir)
	if err != nil {
		return ""
	}
	perm := fi.Mode().Perm()
	if perm&0o077 == 0 {
		return ""
	}
	found := fmt.Sprintf("%s was group or world accessible (mode %o)", dir, perm)
	if err = os.Chmod(dir, paths.DirPerm); err != nil {
		return found + "; chmod failed: " + err.Error()
	}
	return found + "; tightened to 0700"
}

// writePidfile records this process' pid atomically, replacing any stale file
// left behind by a killed instance.
func writePidfile(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), paths.DirPerm); err != nil {
		return fmt.Errorf("create pid file directory: %w", err)
	}
	content := []byte(strconv.Itoa(os.Getpid()) + "\n")

	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return fmt.Errorf("write pid file %s: %w", path, err)
	}
	var ok bool

	defer func() { // the rename consumes tmp, a failed write never leaves it behind
		if !ok {
			_ = os.Remove(tmp.Name())
			_ = tmp.Close()
		}
	}()
	if _, err = tmp.Write(content); err != nil {
		return fmt.Errorf("write pid file %s: %w", path, err)
	}
	if err = tmp.Close(); err != nil {
		return fmt.Errorf("write pid file %s: %w", path, err)
	}
	if err = os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("write pid file %s: %w", path, err)
	}
	ok = true
	return nil
}

// removePidfile deletes the pid file, ignoring an already-gone one.
func removePidfile(path string) {
	_ = os.Remove(path)
}
