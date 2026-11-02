package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAuthFlow(t *testing.T) {
	t.Parallel()

	server, client := newTestAPI(t)
	base := server.URL

	t.Run("pending service answers the marker", func(t *testing.T) {
		for _, path := range []string{"/api/me", "/api/tokens"} {
			code, body := callJSON[map[string]string](t, client, base, http.MethodGet, path, nil)
			assert.Equal(t, http.StatusServiceUnavailable, code, "path %s", path)
			assert.Equal(t, "bootstrap_required", body["error"])
		}
	})

	t.Run("login is gated while pending", func(t *testing.T) {
		code, body := callJSON[map[string]string](t, client, base,
			http.MethodPost, "/api/auth/login", map[string]any{"username": "jent", "password": "x"})
		assert.Equal(t, http.StatusServiceUnavailable, code)
		assert.Equal(t, "bootstrap_required", body["error"])
	})

	t.Run("static stays reachable while pending", func(t *testing.T) {
		resp := call(t, client, base, http.MethodGet, "/", nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		assert.True(t, strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html"))
	})

	t.Run("bootstrap validates input", func(t *testing.T) {
		code, _ := callJSON[struct{}](t, client, base,
			http.MethodPost, "/api/auth/bootstrap", map[string]string{"password": ""})
		assert.Equal(t, http.StatusBadRequest, code)

		code, _ = callJSON[struct{}](t, client, base,
			http.MethodPost, "/api/auth/bootstrap", nil)
		assert.Equal(t, http.StatusBadRequest, code)
	})

	t.Run("bootstrap sets the first password once", func(t *testing.T) {
		code, _ := callJSON[struct{}](t, client, base,
			http.MethodPost, "/api/auth/bootstrap", map[string]string{"password": "hunter2"})
		assert.Equal(t, http.StatusNoContent, code)

		code, body := callJSON[map[string]string](t, client, base,
			http.MethodPost, "/api/auth/bootstrap", map[string]string{"password": "again"})
		assert.Equal(t, http.StatusConflict, code)
		assert.Equal(t, "already_bootstrapped", body["error"])
	})

	t.Run("login checks credentials", func(t *testing.T) {
		code, body := callJSON[map[string]string](t, client, base,
			http.MethodPost, "/api/auth/login",
			map[string]any{"username": "jent", "password": "wrong"})
		assert.Equal(t, http.StatusUnauthorized, code)
		assert.Equal(t, "invalid_credentials", body["error"])

		code, _ = callJSON[struct{}](t, client, base,
			http.MethodPost, "/api/auth/login",
			map[string]any{"username": "jent", "password": "hunter2"})
		require.Equal(t, http.StatusNoContent, code)
	})

	t.Run("me reports the principal", func(t *testing.T) {
		code, body := callJSON[map[string]string](t, client, base, http.MethodGet, "/api/me", nil)
		assert.Equal(t, http.StatusOK, code)
		assert.Equal(t, "jent", body["username"])
		assert.Equal(t, "cookie", body["via"])
	})

	t.Run("logout ends the session", func(t *testing.T) {
		code, _ := callJSON[struct{}](t, client, base, http.MethodPost, "/api/auth/logout", nil)
		assert.Equal(t, http.StatusNoContent, code)

		code, _ = callJSON[struct{}](t, client, base, http.MethodGet, "/api/me", nil)
		assert.Equal(t, http.StatusUnauthorized, code)
	})
}

func TestTokenEndpoints(t *testing.T) {
	t.Parallel()

	server, client := newTestAPI(t)
	base := server.URL
	bootstrapAndLogin(t, client, base)

	t.Run("create returns the secret once", func(t *testing.T) {
		code, body := callJSON[map[string]string](t, client, base,
			http.MethodPost, "/api/tokens", map[string]string{"name": "ci"})
		require.Equal(t, http.StatusCreated, code)
		assert.NotEmpty(t, body["token"])
		assert.True(t, strings.HasPrefix(body["token"], "swt_"))

		code, _ = callJSON[map[string]string](t, client, base,
			http.MethodPost, "/api/tokens", map[string]string{"name": "ci"})
		assert.Equal(t, http.StatusConflict, code)
	})

	t.Run("list omits secrets", func(t *testing.T) {
		code, body := callJSON[[]map[string]any](t, client, base, http.MethodGet, "/api/tokens", nil)
		require.Equal(t, http.StatusOK, code)
		require.Len(t, body, 1)
		assert.Equal(t, "ci", body[0]["name"])
		assert.NotContains(t, body[0], "token")
	})

	t.Run("invalid names rejected", func(t *testing.T) {
		code, _ := callJSON[struct{}](t, client, base,
			http.MethodPost, "/api/tokens", map[string]string{"name": "has space"})
		assert.Equal(t, http.StatusBadRequest, code)
	})

	t.Run("delete revokes", func(t *testing.T) {
		code, _ := callJSON[struct{}](t, client, base, http.MethodDelete, "/api/tokens/ci", nil)
		require.Equal(t, http.StatusNoContent, code)

		code, _ = callJSON[struct{}](t, client, base, http.MethodDelete, "/api/tokens/ci", nil)
		assert.Equal(t, http.StatusNotFound, code)
	})
}

func TestBearerAuthWorksAcrossClients(t *testing.T) {
	t.Parallel()

	server, client := newTestAPI(t)
	base := server.URL
	bootstrapAndLogin(t, client, base)

	code, body := callJSON[map[string]string](t, client, base,
		http.MethodPost, "/api/tokens", map[string]string{"name": "script"})
	require.Equal(t, http.StatusCreated, code)
	secret := body["token"]

	scriptClient := &http.Client{} // no jar: bearer only
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, base+"/api/tokens", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+secret)

	resp, err := scriptClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	// a garbage secret must not authenticate
	req2, err := http.NewRequestWithContext(t.Context(), http.MethodGet, base+"/api/tokens", nil)
	require.NoError(t, err)
	req2.Header.Set("Authorization", "Bearer swt_bogus")
	resp2, err := scriptClient.Do(req2)
	require.NoError(t, err)
	defer func() { _ = resp2.Body.Close() }()
	assert.Equal(t, http.StatusUnauthorized, resp2.StatusCode)
}

func TestRouteBehaviors(t *testing.T) {
	t.Parallel()

	server, client := newTestAPI(t)
	base := server.URL

	t.Run("unknown api path is json 404 when authed", func(t *testing.T) {
		bootstrapAndLogin(t, client, base)
		code, body := callJSON[map[string]string](t, client, base, http.MethodGet, "/api/nope", nil)
		assert.Equal(t, http.StatusNotFound, code)
		assert.Equal(t, "not_found", body["error"])
	})

	t.Run("method mismatch is a 405", func(t *testing.T) {
		code, _ := callJSON[struct{}](t, client, base, http.MethodGet, "/api/auth/login", nil)
		assert.Equal(t, http.StatusMethodNotAllowed, code)
	})

	t.Run("static assets stay reachable", func(t *testing.T) {
		resp := call(t, client, base, http.MethodGet, "/", nil)
		assert.Equal(t, http.StatusOK, resp.StatusCode)
	})
}

func TestBootstrapLoopbackOnly(t *testing.T) {
	t.Parallel()

	handler := Handler(Config{Auth: newTestService(t), Fleet: newTestFleet(t), Log: testLogger()})

	t.Run("remote peer refused", func(t *testing.T) {
		req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/auth/bootstrap", strings.NewReader(`{"password":"x"}`))
		req.RemoteAddr = "203.0.113.7:54321"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("loopback accepted", func(t *testing.T) {
		req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/auth/bootstrap", strings.NewReader(`{"password":"hunter2"}`))
		req.RemoteAddr = "127.0.0.1:54321"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
	})
}
