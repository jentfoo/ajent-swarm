//go:build !unix

package app

import "os/exec"

// detach is a no-op off unix, where daemon mode is unsupported.
func detach(cmd *exec.Cmd) {}
