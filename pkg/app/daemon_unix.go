//go:build unix

package app

import (
	"os/exec"
	"syscall"
)

// detach severs the daemon child from the launching terminal so later Ctrl+C
// or hangs-up in the parent shell never reach it.
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
