package fleet

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
)

func TestSplitQuery(t *testing.T) {
	t.Parallel()

	cwd := "/home/you/project"
	cases := []struct {
		name          string
		query         string
		wantDir       string
		wantBase      string
		wantRelPrefix string
	}{
		{
			name:          "empty completes the working directory",
			query:         "",
			wantDir:       cwd,
			wantBase:      "",
			wantRelPrefix: "",
		},
		{
			name:          "bare prefix matches in cwd",
			query:         "ma",
			wantDir:       cwd,
			wantBase:      "ma",
			wantRelPrefix: "",
		},
		{
			name:          "directory path completes inside it",
			query:         "src/",
			wantDir:       filepath.Join(cwd, "src"),
			wantBase:      "",
			wantRelPrefix: "src/",
		},
		{
			name:          "partial name under a directory keeps the typed prefix",
			query:         "src/ma",
			wantDir:       filepath.Join(cwd, "src"),
			wantBase:      "ma",
			wantRelPrefix: "src/",
		},
		{
			name:          "absolute paths pass through",
			query:         "/etc/ng",
			wantDir:       "/etc",
			wantBase:      "ng",
			wantRelPrefix: "/etc/",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			dir, base, relPrefix := splitQuery(cwd, tc.query)
			assert.Equal(t, tc.wantDir, dir)
			assert.Equal(t, tc.wantBase, base)
			assert.Equal(t, tc.wantRelPrefix, relPrefix)
		})
	}
}

func TestManagerFiles(t *testing.T) {
	// not parallel: newTestFleet pins the ajent home env var

	root := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root, "src", "inner"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(root, "main.go"), []byte("x"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(root, ".hidden"), []byte("x"), 0o600))

	m, home := newTestFleet(t, nil)
	f := fleettest.New(t, home, fleettest.Options{SessionID: "01FILES000000000000"})
	f.SetSnapshot(ctl.State{
		Session:   ctl.Session{ID: f.SessionID()},
		Workspace: root,
		Cwd:       root,
	})
	f.WriteRegistry(t, os.Getpid(), time.Now())
	waitForState(t, m, f.SessionID(), ChildOnline)

	t.Run("unknown session is refused", func(t *testing.T) {
		t.Parallel()
		_, err := m.Files(t.Context(), "01NOBODY00000000", "")
		assert.ErrorIs(t, err, ErrUnknownSession)
	})

	t.Run("empty query lists the cwd, hidden entries quiet", func(t *testing.T) {
		t.Parallel()
		items, err := m.Files(t.Context(), f.SessionID(), "")
		require.NoError(t, err)
		fragments := make([]string, 0, len(items))
		for _, it := range items {
			fragments = append(fragments, it.Path)
		}
		assert.ElementsMatch(t, []string{"main.go", "src/"}, fragments)
	})

	t.Run("hidden entries surface when asked for", func(t *testing.T) {
		t.Parallel()
		items, err := m.Files(t.Context(), f.SessionID(), ".")
		require.NoError(t, err)
		assert.Len(t, items, 1)
		assert.Equal(t, ".hidden", items[0].Path)
	})

	t.Run("prefix narrows and directories keep the slash", func(t *testing.T) {
		t.Parallel()
		items, err := m.Files(t.Context(), f.SessionID(), "sr")
		require.NoError(t, err)
		require.Len(t, items, 1)
		assert.Equal(t, "src/", items[0].Path)
		assert.True(t, items[0].Dir)

		inner, err := m.Files(t.Context(), f.SessionID(), "src/in")
		require.NoError(t, err)
		require.Len(t, inner, 1)
		assert.Equal(t, "src/inner/", inner[0].Path)
	})

	t.Run("unreadable directory answers empty", func(t *testing.T) {
		t.Parallel()
		items, err := m.Files(t.Context(), f.SessionID(), "nowhere/")
		require.NoError(t, err)
		assert.Empty(t, items)
	})
}

func TestSanitizeSessionName(t *testing.T) {
	t.Parallel()

	cases := []struct{ in, want string }{
		{"Fix the login flow", "fix-the-login-flow"},
		{"Answer with, commas!", "answer-with-commas"},
		{"first line only\nsecond line dropped", "first-line-only"},
		{"---already-dashed---", "already-dashed"},
		{"kebab-case-input", "kebab-case-input"},
	}
	for _, tc := range cases {
		assert.Equal(t, tc.want, sanitizeSessionName(tc.in))
	}

	long := sanitizeSessionName(strings.Repeat("word ", 60))
	assert.NotEmpty(t, long)
	assert.LessOrEqual(t, len(long), maxNameRunes)
	assert.Empty(t, sanitizeSessionName("!!! ..."))
}
