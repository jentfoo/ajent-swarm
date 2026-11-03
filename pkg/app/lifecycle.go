package app

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jentfoo/ajent/pkg/paths"
)

// Stop escalation windows and poll cadence; tunable so tests stay quick.
var (
	stopTermWait = 10 * time.Second
	stopKillWait = 5 * time.Second
	stopPoll     = 50 * time.Millisecond
)

// Stop terminates the service instance named by the pid file: SIGTERM first,
// SIGKILL when the graceful window passes. A stale pid file is cleaned up and
// stopping an already-stopped instance succeeds.
func Stop(stateDir, pidfile string, stdout, stderr io.Writer) int {
	path, err := resolvePidPath(stateDir, pidfile)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "ajent-swarm: %v\n", err)
		return 1
	}

	pid, err := readPidFile(path)
	if err != nil {
		_, _ = fmt.Fprintln(stdout, "ajent-swarm is not running")
		return 0
	}
	if !pidAlive(pid) {
		removePidfile(path)
		_, _ = fmt.Fprintf(stdout, "ajent-swarm is not running (stale pid file removed, pid %d)\n", pid)
		return 0
	}

	if err = signalPid(pid, syscall.SIGTERM); err != nil {
		_, _ = fmt.Fprintf(stderr, "ajent-swarm: signal pid %d: %v\n", pid, err)
		return 1
	}
	if waitGone(pid, stopTermWait) {
		removePidfile(path) // the service usually removed it itself on the way out
		_, _ = fmt.Fprintf(stdout, "ajent-swarm stopped (pid %d)\n", pid)
		return 0
	}

	_ = signalPid(pid, syscall.SIGKILL)
	if waitGone(pid, stopKillWait) {
		removePidfile(path) // SIGKILL leaves the file behind
		_, _ = fmt.Fprintf(stdout, "ajent-swarm stopped (pid %d, forced)\n", pid)
		return 0
	}
	_, _ = fmt.Fprintf(stderr, "ajent-swarm: pid %d did not exit; see %s\n", pid, path)
	return 1
}

// Status reports whether the pid file names a live instance. The exit code is
// the answer: 0 when running, 1 when stopped.
func Status(stateDir, pidfile string, stdout, stderr io.Writer) int {
	path, err := resolvePidPath(stateDir, pidfile)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "ajent-swarm: %v\n", err)
		return 1
	}

	pid, err := readPidFile(path)
	if err != nil {
		_, _ = fmt.Fprintln(stdout, "ajent-swarm stopped")
		return 1
	}
	if !pidAlive(pid) {
		_, _ = fmt.Fprintf(stdout, "ajent-swarm stopped (stale pid file, pid %d)\n", pid)
		return 1
	}
	_, _ = fmt.Fprintf(stdout, "ajent-swarm running (pid %d)\n", pid)
	return 0
}

// resolvePidPath resolves the pid file location: an explicit path wins, then
// one inside the state directory, then the default under the ajent home. The
// default resolves without creating anything, so status and stop never leave
// directories behind.
func resolvePidPath(stateDir, pidfile string) (string, error) {
	if pidfile != "" {
		if !filepath.IsAbs(pidfile) {
			abs, err := filepath.Abs(pidfile)
			if err != nil {
				return "", fmt.Errorf("resolve --pidfile %s: %w", pidfile, err)
			}
			pidfile = abs
		}
		return pidfile, nil
	}
	if stateDir != "" {
		return filepath.Join(stateDir, pidFileName), nil
	}
	home, err := paths.Home()
	if err != nil {
		return "", fmt.Errorf("resolve state directory: %w", err)
	}
	return filepath.Join(home, swarmDirName, pidFileName), nil
}

// readPidFile reads the pid recorded in path; any unreadable or malformed
// file reports not running.
func readPidFile(path string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return 0, errors.New("malformed pid file")
	}
	return pid, nil
}

// waitGone polls until pid stops answering signal zero or the wait elapses.
// After a signal was delivered successfully, EPERM means the target died and
// its pid was reused by another user's process, so only a nil kill reads as
// alive here.
func waitGone(pid int, wait time.Duration) bool {
	deadline := time.Now().Add(wait)
	for {
		if !signalZeroOK(pid) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(stopPoll)
	}
}
