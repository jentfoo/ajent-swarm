//go:build unix

package app

import (
	"errors"
	"os"
	"syscall"
)

func signalPid(pid int, sig syscall.Signal) error {
	return syscall.Kill(pid, sig)
}

// lockFile holds an exclusive advisory lock on f for its lifetime, failing at
// once when another process already holds it.
func lockFile(f *os.File) error {
	err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return errLocked
	}
	return err
}

// signalZero probes pid with the harmless signal zero.
func signalZero(pid int) error {
	if pid <= 0 {
		return syscall.ESRCH
	}
	return syscall.Kill(pid, 0)
}

// pidAlive reports whether pid names a live process. A pid owned by another
// user counts as alive, since EPERM still proves one exists.
func pidAlive(pid int) bool {
	err := signalZero(pid)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// signalZeroOK is true only when signal zero reaches pid unwrapped: an EPERM
// from a recycled pid owned by another user reads as the original being gone.
func signalZeroOK(pid int) bool {
	return signalZero(pid) == nil
}
