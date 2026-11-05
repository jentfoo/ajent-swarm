package app

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	// daemonChildEnv marks this process as the detached child of a --daemon
	// parent, so it serves instead of spawning again.
	daemonChildEnv = "AJENT_SWARM_DAEMON_CHILD"
	// readyFileEnv names the file the child reports its startup outcome
	// through, so failures reach the user synchronously without long-lived
	// parent bookkeeping.
	readyFileEnv = "AJENT_SWARM_READY_FILE"

	readyTimeout = 10 * time.Second // parent wait for the child's first word
	readyPoll    = 25 * time.Millisecond
)

// isDaemonChild reports whether this process was spawned by --daemon.
func isDaemonChild() bool {
	return os.Getenv(daemonChildEnv) == "1"
}

// daemonize spawns a detached copy of argv and waits for its startup outcome:
// success returns promptly, failure surfaces the child's error.
func daemonize(opts Options, argv []string, stdout, stderr io.Writer) int {
	dir, _, err := ensureStateDir(opts.StateDir)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "ajent-swarm: %v\n", err)
		return 1
	}
	logPath := opts.LogPath
	if logPath == "" {
		logPath = filepath.Join(dir, logFileName)
	}
	lf, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "ajent-swarm: open log %s: %v\n", logPath, err)
		return 1
	}
	defer func() { _ = lf.Close() }()

	readyPath, cleanupReady, err := makeReadyFile()
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "ajent-swarm: %v\n", err)
		return 1
	}
	defer cleanupReady()

	exe, err := os.Executable()
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "ajent-swarm: resolve executable: %v\n", err)
		return 1
	}

	// no deadline: the child owns its lifetime; readiness is bounded below
	cmd := exec.Command(exe, argv...) //nolint:noctx // detached daemon child, lifetime owned by itself
	cmd.Env = append(os.Environ(),
		daemonChildEnv+"=1",
		readyFileEnv+"="+readyPath)
	cmd.Stdout = lf
	cmd.Stderr = lf
	detach(cmd)
	if err = cmd.Start(); err != nil {
		_, _ = fmt.Fprintf(stderr, "ajent-swarm: start daemon: %v\n", err)
		return 1
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	deadline := time.After(readyTimeout)
	for {
		data, err := os.ReadFile(readyPath) // the child's one-line status once present
		if line := strings.TrimSpace(string(data)); err == nil && line != "" {
			if reason, failed := strings.CutPrefix(line, "error "); failed {
				_, _ = fmt.Fprintf(stderr, "ajent-swarm: daemon startup failed: %s\n", reason)
				return 1
			}
			_, _ = fmt.Fprintf(stdout, "ajent-swarm daemon started (pid %d)\nlog: %s\n",
				cmd.Process.Pid, logPath)
			return 0
		}

		select {
		case err := <-done:
			if err == nil {
				err = errors.New("exited without reporting")
			}
			_, _ = fmt.Fprintf(stderr, "ajent-swarm: daemon exited during startup (%v); see %s\n",
				err, logPath)
			return 1
		case <-deadline:
			_ = cmd.Process.Kill()
			_, _ = fmt.Fprintf(stderr, "ajent-swarm: daemon did not report within %s; killed; see %s\n",
				readyTimeout, logPath)
			return 1
		case <-time.After(readyPoll):
		}
	}
}

// makeReadyFile creates the temp file the child reports through and returns a
// cleanup function for it.
func makeReadyFile() (path string, cleanup func(), err error) {
	f, err := os.CreateTemp("", "ajent-swarm-ready-*")
	if err != nil {
		return "", nil, fmt.Errorf("create ready file: %w", err)
	}
	path = f.Name()
	if err = f.Close(); err != nil {
		_ = os.Remove(path)
		return "", nil, fmt.Errorf("create ready file: %w", err)
	}
	return path, func() { _ = os.Remove(path) }, nil
}

// notifyReady reports this child's startup outcome to a waiting --daemon
// parent. It is a no-op outside daemon children.
func notifyReady(format string, args ...any) {
	path := os.Getenv(readyFileEnv)
	if path == "" {
		return
	}
	_ = os.WriteFile(path, []byte(fmt.Sprintf(format, args...)), 0o600)
}
