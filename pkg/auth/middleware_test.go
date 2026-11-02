package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newGate builds a gated handler with one exempt status route and one
// protected route, plus a client helper for requests.
func newGate(t *testing.T) (*Service, http.Handler) {
	t.Helper()
	svc, _, _ := newTestAuth(t)
	require.NoError(t, svc.EnsureUser(t.Context(), "jent"))

	exempt := func(r *http.Request) bool { return r.URL.Path == "/api/me" }
	mux := http.NewServeMux()
	mux.HandleFunc(http.MethodPost+" "+BootstrapPath, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /api/me", func(w http.ResponseWriter, r *http.Request) {
		p, ok := PrincipalFrom(r.Context())
		if !ok {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(p.Username))
	})
	mux.HandleFunc("GET /api/secret", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	return svc, svc.Middleware(exempt)(mux)
}

func TestMiddleware(t *testing.T) {
	t.Parallel()

	_, handler := newGate(t)

	t.Run("pending gate marks every route", func(t *testing.T) {
		for _, path := range []string{"/api/secret", "/api/me"} {
			req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusServiceUnavailable, rec.Code, "path %s", path)
			var body map[string]string
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			assert.Equal(t, "bootstrap_required", body["error"])
		}
	})

	t.Run("bootstrap endpoint passes while pending", func(t *testing.T) {
		req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, BootstrapPath, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
	})
}

func TestMiddlewareAfterBootstrap(t *testing.T) {
	t.Parallel()

	svc, handler := newGate(t)
	ctx := t.Context()
	require.NoError(t, svc.SetPassword(ctx, "hunter2"))

	t.Run("anonymous request refused", func(t *testing.T) {
		req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/secret", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("exempt status route passes anonymously", func(t *testing.T) {
		req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/me", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusUnauthorized, rec.Code, "me answers for itself")
	})

	t.Run("session cookie authenticates", func(t *testing.T) {
		token, err := svc.Login(ctx, "jent", "hunter2")
		require.NoError(t, err)

		req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/secret", nil)
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: token})
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("stale cookie with fresh bearer authenticates", func(t *testing.T) {
		badCookie := &http.Cookie{Name: SessionCookieName, Value: "expired"}
		req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/secret", nil)
		req.AddCookie(badCookie)

		token, err := svc.CreateToken(ctx, "ci")
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+token)

		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
	})
}
