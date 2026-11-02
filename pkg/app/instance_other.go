//go:build !unix

package app

import (
	"errors"
	"os"
)

// lockFile is unsupported off unix, where the service cannot run safely
// anyway: there is no single-instance guard without it.
func lockFile(f *os.File) error {
	return errors.New("single-instance locking requires a unix system")
}
