//go:build !unix

package app

import (
	"errors"
	"os"
	"syscall"
)

// signalPid is unsupported off unix, where the service cannot run.
func signalPid(pid int, sig syscall.Signal) error {
	return errors.New("process signals require a unix system")
}

// pidAlive reports no process alive off unix.
func pidAlive(int) bool {
	return false
}

// signalZeroOK reports no process alive off unix.
func signalZeroOK(int) bool {
	return false
}

// lockFile is unsupported off unix, where the service cannot run safely
// anyway: there is no single-instance guard without it.
func lockFile(f *os.File) error {
	return errors.New("single-instance locking requires a unix system")
}
