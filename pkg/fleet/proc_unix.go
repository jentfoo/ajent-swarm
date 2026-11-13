//go:build unix

package fleet

import (
	"errors"
	"os"
	"syscall"
)

// errNoSpawn guards launching on platforms without process groups.
var errNoSpawn = errors.New("launching children is unsupported on this platform")

func spawnSupported() bool { return true }

// procAttrs puts the child in its own process group: a restart of the web
// service never destroys running agent runs, and a group signal reaches
// ajent's own subprocesses.
func procAttrs() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

// signalGroup signals the child's whole process group. The child is the
// group leader, so -pid addresses exactly it and its subprocesses, adopted
// orphans keep the group their spawning service gave them.
func signalGroup(pid int, sig syscall.Signal) error {
	return syscall.Kill(-pid, sig)
}

// pidGone reports whether no process answers at pid, judged with signal
// zero: undecidable cases read as alive, so a caller only drops a child on
// proof of death.
func pidGone(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = proc.Signal(syscall.Signal(0))
	return errors.Is(err, syscall.ESRCH) || errors.Is(err, os.ErrProcessDone)
}
