package fleet

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
)

func TestFiles(t *testing.T) {
	// not parallel: newTestFleet pins the ajent home env var

	t.Run("manager_files", func(t *testing.T) {
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

		t.Run("unknown_session_is_refused", func(t *testing.T) {
			_, err := m.Files(t.Context(), "01NOBODY00000000", "")
			assert.ErrorIs(t, err, ErrUnknownSession)
		})

		t.Run("empty_query_lists_cwd", func(t *testing.T) {
			items, err := m.Files(t.Context(), f.SessionID(), "")
			require.NoError(t, err)
			fragments := make([]string, 0, len(items))
			for _, it := range items {
				fragments = append(fragments, it.Path)
			}
			assert.ElementsMatch(t, []string{"main.go", "src/"}, fragments)
		})

		t.Run("hidden_entries_when_asked", func(t *testing.T) {
			items, err := m.Files(t.Context(), f.SessionID(), ".")
			require.NoError(t, err)
			assert.Len(t, items, 1)
			assert.Equal(t, ".hidden", items[0].Path)
		})

		t.Run("prefix_narrows_keep_slash", func(t *testing.T) {
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

		t.Run("missing_directory_answers_empty", func(t *testing.T) {
			items, err := m.Files(t.Context(), f.SessionID(), "nowhere/")
			require.NoError(t, err)
			assert.Empty(t, items)
		})
	})
}

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
			name:          "empty_completes_the_working_directory",
			query:         "",
			wantDir:       cwd,
			wantBase:      "",
			wantRelPrefix: "",
		},
		{
			name:          "bare_prefix_matches_in_cwd",
			query:         "ma",
			wantDir:       cwd,
			wantBase:      "ma",
			wantRelPrefix: "",
		},
		{
			name:          "directory_path_completes_inside_it",
			query:         "src/",
			wantDir:       filepath.Join(cwd, "src"),
			wantBase:      "",
			wantRelPrefix: "src/",
		},
		{
			name:          "partial_prefix_under_directory",
			query:         "src/ma",
			wantDir:       filepath.Join(cwd, "src"),
			wantBase:      "ma",
			wantRelPrefix: "src/",
		},
		{
			name:          "absolute_paths_pass_through",
			query:         "/etc/ng",
			wantDir:       "/etc",
			wantBase:      "ng",
			wantRelPrefix: "/etc/",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir, base, relPrefix := splitQuery(cwd, tc.query)
			assert.Equal(t, tc.wantDir, dir)
			assert.Equal(t, tc.wantBase, base)
			assert.Equal(t, tc.wantRelPrefix, relPrefix)
		})
	}
}
