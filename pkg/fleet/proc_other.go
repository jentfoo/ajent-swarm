//go:build !unix

package fleet

import (
	"errors"
	"syscall"
)

// errNoSpawn guards launching on platforms without process groups.
var errNoSpawn = errors.New("launching children is unsupported on this platform")

func spawnSupported() bool { return false }

func procAttrs() *syscall.SysProcAttr { return nil }

func signalGroup(pid int, sig syscall.Signal) error {
	return errors.New("process groups are unsupported on this platform")
}

func pidGone(pid int) bool { return false }
