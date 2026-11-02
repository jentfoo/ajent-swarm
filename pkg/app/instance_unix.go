//go:build unix

package app

import (
	"errors"
	"os"
	"syscall"
)

// lockFile holds an exclusive advisory lock on f for its lifetime, failing at
// once when another process already holds it.
func lockFile(f *os.File) error {
	err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return errLocked
	}
	return err
}
