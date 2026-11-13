// Package testutil keeps tests off the developer's real ajent home. Fleet
// attach and saved-session review resolve AJENT_HOME, so leaving it unset
// points default discovery and transcript listing at ~/.ajent.
package testutil

import (
	"os"
	"testing"

	"github.com/jentfoo/ajent/pkg/paths"
)

// IsolateHome pins AJENT_HOME to a fresh short temp directory and returns
// it, so discovery and saved-session reads stay off the real home. The dir
// name stays short because control socket paths cap at ~108 bytes. Tests
// needing a specific home call t.Setenv again with their own.
func IsolateHome(t *testing.T) string {
	t.Helper()
	home, err := os.MkdirTemp("", "ajent-home")
	if err != nil {
		t.Fatalf("create isolated AJENT_HOME: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	t.Setenv(paths.EnvHome, home)
	return home
}
