package api

import (
	"context"
	"encoding/json"
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
	"github.com/jentfoo/ajent/pkg/ctl"
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
	mgr.Start(context.Background())
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

// bootstrapAndLogin brings a fresh service past bootstrap and signs in.
func bootstrapAndLogin(t *testing.T, client *http.Client, baseURL string) {
	t.Helper()
	code, _ := callJSON[struct{}](t, client, baseURL, http.MethodPost, "/api/auth/bootstrap", map[string]string{"password": "hunter2"})
	require.Equal(t, http.StatusNoContent, code)

	code, _ = callJSON[struct{}](t, client, baseURL, http.MethodPost, "/api/auth/login", map[string]any{"username": "jent", "password": "hunter2"})
	require.Equal(t, http.StatusNoContent, code)
}
