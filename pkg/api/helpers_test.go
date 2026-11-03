package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"

	"github.com/jentfoo/ajent-swarm/pkg/auth"
	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	"github.com/jentfoo/ajent-swarm/pkg/store"
	"github.com/jentfoo/ajent-swarm/pkg/testutil"

	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/llm"
	"github.com/jentfoo/ajent/pkg/session"
)

// testLogger silences request logs during handler-level tests.
func testLogger() *slog.Logger {
	return slog.New(slog.DiscardHandler)
}

// newTestFleet runs a fast manager over an empty registry, so handlers see a
// live but sessionless fleet without touching AJENT_HOME.
func newTestFleet(t *testing.T) *fleet.Manager {
	t.Helper()
	mgr := fleet.New(fleet.Options{
		Log:          testLogger(),
		PollInterval: 10 * time.Millisecond,
		BackoffBase:  5 * time.Millisecond,
		BackoffMax:   50 * time.Millisecond,
		Discover:     func() ([]ctl.Instance, error) { return nil, nil },
	})
	mgr.Start(t.Context())
	t.Cleanup(mgr.Stop)
	return mgr
}

// newTestService builds an auth service over a throwaway store, seeded and
// ready for handler-level tests that bypass the HTTP server.
func newTestService(t *testing.T) *auth.Service {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), store.FileName))
	require.NoError(t, err)
	t.Cleanup(func() { _ = st.Close() })

	svc, err := auth.NewService(st, auth.WithBcryptCost(bcrypt.MinCost))
	require.NoError(t, err)
	require.NoError(t, svc.EnsureUser(t.Context(), "jent"))
	return svc
}

// newTestAPI builds the full handler over a throwaway store behind
// httptest, with a cookie-jarred client for authenticated flows.
func newTestAPI(t *testing.T) (*httptest.Server, *http.Client) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), store.FileName))
	require.NoError(t, err)
	t.Cleanup(func() { _ = st.Close() })

	svc, err := auth.NewService(st, auth.WithBcryptCost(bcrypt.MinCost))
	require.NoError(t, err)
	require.NoError(t, svc.EnsureUser(t.Context(), "jent"))
	server := httptest.NewServer(Handler(Config{Auth: svc, Fleet: newTestFleet(t), Log: testLogger()}))
	t.Cleanup(server.Close)

	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	return server, &http.Client{Jar: jar}
}

// call issues one request against the test server and returns the response.
func call(t *testing.T, client *http.Client, baseURL, method, path string, body io.Reader) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, baseURL+path, body)
	require.NoError(t, err)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

// callJSON issues a JSON request and decodes the response body into T.
func callJSON[T any](t *testing.T, client *http.Client, baseURL, method, path string, body any) (int, T) {
	t.Helper()
	raw, err := json.Marshal(body)
	require.NoError(t, err)

	resp := call(t, client, baseURL, method, path, strings.NewReader(string(raw)))
	var out T
	readErr := json.NewDecoder(resp.Body).Decode(&out)
	if readErr != nil && readErr != io.EOF { // 204s decode to the zero value
		require.NoError(t, readErr)
	}
	return resp.StatusCode, out
}

// titleStore adapts the SQLite store to fleet's TitleStore interface.
type titleStore struct{ st *store.Store }

func (a titleStore) SetSessionTitle(ctx context.Context, sessionID, title string) error {
	return a.st.SetSessionTitle(ctx, sessionID, title)
}

func (a titleStore) SessionTitles(ctx context.Context) (map[string]string, error) {
	return a.st.SessionTitles(ctx)
}

// settingsStore adapts the SQLite store to fleet's SettingsStore interface,
// mirroring pkg/app's production adapter.
type settingsStore struct{ st *store.Store }

func (a settingsStore) Setting(ctx context.Context, key string) (string, error) {
	return a.st.Setting(ctx, key)
}

func (a settingsStore) SetSetting(ctx context.Context, key, value string) error {
	return a.st.SetSetting(ctx, key, value)
}

// recallStore adapts the SQLite store to fleet's RecallStore interface,
// mirroring pkg/app's production adapter.
type recallStore struct{ st *store.Store }

func (a recallStore) RecordRecallLine(ctx context.Context,
	workspace, text string, at time.Time,
) (int64, error) {
	return a.st.RecordRecallLine(ctx, workspace, text, at)
}

func (a recallStore) ScrubRecallLine(ctx context.Context, id int64) error {
	err := a.st.ScrubRecallLine(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return nil // the cap already pruned the row; nothing to withhold
	}
	return err
}

func (a recallStore) RecallLines(ctx context.Context,
	workspace, query string, limit int,
) ([]fleet.RecallLine, error) {
	rows, err := a.st.RecallLines(ctx, workspace, query, limit)
	if err != nil {
		return nil, err
	}
	out := make([]fleet.RecallLine, len(rows))
	for i, r := range rows {
		out[i] = fleet.RecallLine{ID: r.ID, Text: r.Text, CreatedAt: r.CreatedAt}
	}
	return out, nil
}

// bootstrapAndLogin brings a fresh service past bootstrap and signs in.
func bootstrapAndLogin(t *testing.T, client *http.Client, baseURL string) {
	t.Helper()
	code, _ := callJSON[struct{}](t, client, baseURL, http.MethodPost, "/api/auth/bootstrap", map[string]string{"password": "hunter2"})
	require.Equal(t, http.StatusNoContent, code)

	code, _ = callJSON[struct{}](t, client, baseURL, http.MethodPost, "/api/auth/login", map[string]any{"username": "jent", "password": "hunter2"})
	require.Equal(t, http.StatusNoContent, code)
}

// newFleetAPI builds the full handler over a live fleet manager pointed at a
// temp AJENT_HOME, behind httptest with a cookie-jarred client.
func newFleetAPI(t *testing.T) (*httptest.Server, *http.Client, string) {
	t.Helper()
	home := testutil.IsolateHome(t)

	svc := newTestService(t)
	fleetMgr := fleet.New(fleet.Options{
		Log:          testLogger(),
		PollInterval: 10 * time.Millisecond,
		BackoffBase:  5 * time.Millisecond,
		BackoffMax:   50 * time.Millisecond,
	})
	fleetMgr.Start(t.Context())
	t.Cleanup(fleetMgr.Stop)

	server := httptest.NewServer(Handler(Config{Auth: svc, Fleet: fleetMgr, Log: testLogger()}))
	t.Cleanup(server.Close)

	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	client := &http.Client{Jar: jar}
	bootstrapAndLogin(t, client, server.URL)
	return server, client, home
}

// waitOnline blocks until the fleet listing reports the session live.
func waitOnline(t *testing.T, client *http.Client, base, sessionID string) {
	t.Helper()
	require.Eventually(t, func() bool {
		code, body := callJSON[[]map[string]any](t, client, base, http.MethodGet, "/api/sessions", nil)
		if code != http.StatusOK || len(body) != 1 {
			return false
		}
		return body[0]["sessionId"] == sessionID && body[0]["state"] == "online"
	}, 3*time.Second, 20*time.Millisecond)
}

// entryOf builds one committed message transcript entry.
func entryOf(id, parent string) session.Entry {
	data, err := json.Marshal(session.MessageData{Message: llm.Text(llm.RoleUser, "hello")})
	if err != nil { // unreachable for plain message payloads
		panic(err)
	}
	return session.Entry{ID: id, ParentID: parent, Type: session.TypeMessage, Data: data}
}
