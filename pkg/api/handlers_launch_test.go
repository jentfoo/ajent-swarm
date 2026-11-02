package api

import (
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"

	"github.com/jentfoo/ajent-swarm/pkg/auth"
	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	"github.com/jentfoo/ajent-swarm/pkg/store"
	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/paths"
	"github.com/jentfoo/ajent/pkg/session"
)

// newLaunchAPI serves the phase 04 endpoints over a temp ajent home,
// returning the server, an authenticated client and the home for fixtures.
func newLaunchAPI(t *testing.T) (*httptest.Server, *http.Client, string) {
	t.Helper()
	home, err := os.MkdirTemp("", "savedapi")
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	t.Setenv(paths.EnvHome, home)

	st, err := store.Open(filepath.Join(t.TempDir(), store.FileName))
	require.NoError(t, err)
	t.Cleanup(func() { _ = st.Close() })

	svc, err := auth.NewService(st, auth.WithBcryptCost(bcrypt.MinCost))
	require.NoError(t, err)
	require.NoError(t, svc.EnsureUser(t.Context(), "jent"))

	mgr := fleet.New(fleet.Options{
		Log:          testLogger(),
		PollInterval: 10 * time.Millisecond,
		Discover:     func() ([]ctl.Instance, error) { return nil, nil },
	})
	mgr.Start(t.Context())
	t.Cleanup(mgr.Stop)

	server := httptest.NewServer(Handler(Config{Auth: svc, Fleet: mgr, Log: testLogger()}))
	t.Cleanup(server.Close)

	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	client := &http.Client{Jar: jar}
	bootstrapAndLogin(t, client, server.URL)
	return server, client, home
}

type savedFixture struct {
	namedID string
	plainID string
}

// writeSavedFixtures lays down two transcripts: a named one holding an
// abandoned fork the tip derivation must skip, and a bare unnamed one.
func writeSavedFixtures(t *testing.T, home string) savedFixture {
	t.Helper()
	now := time.Now().UnixMilli()
	dir := filepath.Join(home, "sessions", "proj")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	fix := savedFixture{namedID: "01SAVEDNAMED00000001", plainID: "01SAVEDPLAIN0000001"}

	write := func(name string, entries ...session.Entry) {
		var buf []byte
		for _, e := range entries {
			line, err := json.Marshal(e)
			require.NoError(t, err)
			buf = append(buf, line...)
			buf = append(buf, '\n')
		}
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), buf, 0o600))
	}
	sessEntry := func(id, name string) session.Entry {
		raw, err := json.Marshal(map[string]any{
			"version": 1, "cwd": home, "workspace": "/repo", "name": name,
		})
		require.NoError(t, err)
		return session.Entry{ID: id, Type: session.TypeSession, TS: now, Data: raw}
	}
	msgEntry := func(id, parent, text string, ts int64) session.Entry {
		raw, err := json.Marshal(map[string]any{
			"message": map[string]any{
				"role":    "user",
				"content": []any{map[string]any{"type": "text", "data": map[string]any{"text": text}}},
			},
		})
		require.NoError(t, err)
		return session.Entry{ID: id, ParentID: parent, Type: session.TypeMessage, TS: ts, Data: raw}
	}

	write("named.jsonl",
		sessEntry(fix.namedID, "deploy-job"),
		msgEntry("m1", fix.namedID, "ship it", now+1),
		msgEntry("fork", "m1", "abandoned", now+2),
		msgEntry("tip", "m1", "kept", now+5),
	)
	write("plain.jsonl", sessEntry(fix.plainID, ""))
	return fix
}

func TestSavedSessionsListing(t *testing.T) {
	server, client, home := newLaunchAPI(t)
	fix := writeSavedFixtures(t, home)

	code, rows := callJSON[[]fleet.SavedSession](t, client, server.URL, http.MethodGet, "/api/saved-sessions", nil)
	require.Equal(t, http.StatusOK, code)
	require.Len(t, rows, 2)

	// most recently used first; the named session has the newer entries
	assert.Equal(t, fix.namedID, rows[0].ID)
	assert.Equal(t, "deploy-job", rows[0].Name)
	assert.Equal(t, "deploy-job", rows[0].Target)
	assert.Equal(t, "/repo", rows[0].Workspace)
	assert.Equal(t, 2, rows[0].Messages) // the fork's message stays out of the branch
	assert.Equal(t, "ship it", rows[0].First)
	assert.False(t, rows[0].Blocked)
	assert.False(t, rows[0].Live)

	assert.Equal(t, fix.plainID, rows[1].ID)
	assert.Equal(t, fix.plainID, rows[1].Target) // unnamed rows resume by id
}

func TestSavedEntriesPages(t *testing.T) {
	server, client, home := newLaunchAPI(t)
	fix := writeSavedFixtures(t, home)

	t.Run("branch_under_derived_tip", func(t *testing.T) {
		code, page := callJSON[fleet.SavedEntriesPage](t, client, server.URL,
			http.MethodGet, "/api/saved-sessions/"+fix.namedID+"/entries", nil)
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, "tip", page.Head) // the abandoned fork loses to the live leaf
		assert.Equal(t, []string{fix.namedID, "m1", "tip"}, entryIDs(page.Entries))
		assert.Empty(t, page.Cursor) // the whole branch fit
	})

	t.Run("cursor_pages_older_entries", func(t *testing.T) {
		code, older := callJSON[fleet.SavedEntriesPage](t, client, server.URL,
			http.MethodGet, "/api/saved-sessions/"+fix.namedID+"/entries?before=m1&limit=1", nil)
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, []string{fix.namedID}, entryIDs(older.Entries))
		assert.Empty(t, older.Cursor)
	})

	t.Run("name_target_resolves", func(t *testing.T) {
		code, byName := callJSON[fleet.SavedEntriesPage](t, client, server.URL,
			http.MethodGet, "/api/saved-sessions/deploy-job/entries", nil)
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, "tip", byName.Head)
	})

	t.Run("unknown_target_is_404", func(t *testing.T) {
		code, _ := callJSON[fleet.SavedEntriesPage](t, client, server.URL,
			http.MethodGet, "/api/saved-sessions/01NOPE/entries", nil)
		assert.Equal(t, http.StatusNotFound, code)
	})
}

func TestSavedEntriesRefusesBlockedFormat(t *testing.T) {
	server, client, home := newLaunchAPI(t)
	dir := filepath.Join(home, "sessions", "proj")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	raw, err := json.Marshal(map[string]any{"version": 99, "workspace": "/repo"})
	require.NoError(t, err)
	entry := session.Entry{ID: "01BLOCKED0000000001", Type: session.TypeSession, TS: 1, Data: raw}
	line, err := json.Marshal(entry)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "blocked.jsonl"), append(line, '\n'), 0o600))

	code, rows := callJSON[[]fleet.SavedSession](t, client, server.URL, http.MethodGet, "/api/saved-sessions", nil)
	require.Equal(t, http.StatusOK, code)
	require.Len(t, rows, 1)
	assert.True(t, rows[0].Blocked)

	code, _ = callJSON[fleet.SavedEntriesPage](t, client, server.URL,
		http.MethodGet, "/api/saved-sessions/"+rows[0].ID+"/entries", nil)
	assert.Equal(t, http.StatusConflict, code)
}

func TestLaunchAndStopHandlers(t *testing.T) {
	server, client, _ := newLaunchAPI(t)

	t.Run("invalid launch is 400", func(t *testing.T) {
		// refused before any process work; the fleet here has no launch
		// wiring, so nothing else could succeed either
		code, _ := callJSON[struct{}](t, client, server.URL, http.MethodPost, "/api/sessions",
			fleet.LaunchRequest{Mode: fleet.LaunchResume})
		assert.Equal(t, http.StatusBadRequest, code)
	})

	t.Run("unknown stop is 404", func(t *testing.T) {
		code, _ := callJSON[struct{}](t, client, server.URL,
			http.MethodPost, "/api/sessions/01NOPE/stop", nil)
		assert.Equal(t, http.StatusNotFound, code)
	})
}

func entryIDs(entries []ctl.Entry) []string {
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.ID)
	}
	return out
}
