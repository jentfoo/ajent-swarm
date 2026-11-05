package api

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent-swarm/pkg/auth"
)

func TestAuthHandlers(t *testing.T) {
	t.Parallel()

	t.Run("auth_flow", func(t *testing.T) {
		server, client := newTestAPI(t)
		base := server.URL

		t.Run("pending_service_answers_the_marker", func(t *testing.T) {
			for _, path := range []string{"/api/me", "/api/tokens"} {
				code, body := callJSON[map[string]string](t, client, base, http.MethodGet, path, nil)
				assert.Equal(t, http.StatusServiceUnavailable, code)
				assert.Equal(t, "bootstrap_required", body["error"])
			}
		})

		t.Run("login_is_gated_while_pending", func(t *testing.T) {
			code, body := callJSON[map[string]string](t, client, base,
				http.MethodPost, "/api/auth/login", map[string]any{"username": "jent", "password": "x"})
			assert.Equal(t, http.StatusServiceUnavailable, code)
			assert.Equal(t, "bootstrap_required", body["error"])
		})

		t.Run("static_stays_reachable_while_pending", func(t *testing.T) {
			resp := call(t, client, base, http.MethodGet, "/", nil)
			require.Equal(t, http.StatusOK, resp.StatusCode)
			assert.True(t, strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html"))
		})

		t.Run("bootstrap_validates_input", func(t *testing.T) {
			code, _ := callJSON[struct{}](t, client, base,
				http.MethodPost, "/api/auth/bootstrap", map[string]string{"password": ""})
			assert.Equal(t, http.StatusBadRequest, code)

			code, _ = callJSON[struct{}](t, client, base,
				http.MethodPost, "/api/auth/bootstrap", nil)
			assert.Equal(t, http.StatusBadRequest, code)
		})

		t.Run("bootstrap_sets_first_password", func(t *testing.T) {
			code, _ := callJSON[struct{}](t, client, base,
				http.MethodPost, "/api/auth/bootstrap", map[string]string{"password": "hunter2"})
			assert.Equal(t, http.StatusNoContent, code)

			code, body := callJSON[map[string]string](t, client, base,
				http.MethodPost, "/api/auth/bootstrap", map[string]string{"password": "again"})
			assert.Equal(t, http.StatusConflict, code)
			assert.Equal(t, "already_bootstrapped", body["error"])
		})

		t.Run("login_checks_credentials", func(t *testing.T) {
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

		t.Run("me_reports_the_principal", func(t *testing.T) {
			code, body := callJSON[map[string]string](t, client, base, http.MethodGet, "/api/me", nil)
			assert.Equal(t, http.StatusOK, code)
			assert.Equal(t, "jent", body["username"])
			assert.Equal(t, "cookie", body["via"])
		})

		t.Run("logout_ends_the_session", func(t *testing.T) {
			code, _ := callJSON[struct{}](t, client, base, http.MethodPost, "/api/auth/logout", nil)
			assert.Equal(t, http.StatusNoContent, code)

			code, _ = callJSON[struct{}](t, client, base, http.MethodGet, "/api/me", nil)
			assert.Equal(t, http.StatusUnauthorized, code)
		})
	})

	t.Run("bootstrap_loopback_only", func(t *testing.T) {
		handler := Handler(Config{Auth: newTestService(t), Fleet: newTestFleet(t), Log: testLogger()})

		t.Run("remote_peer_refused", func(t *testing.T) {
			req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/auth/bootstrap", strings.NewReader(`{"password":"x"}`))
			req.RemoteAddr = "203.0.113.7:54321"
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusForbidden, rec.Code)
		})

		t.Run("loopback_accepted", func(t *testing.T) {
			req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/auth/bootstrap", strings.NewReader(`{"password":"hunter2"}`))
			req.RemoteAddr = "127.0.0.1:54321"
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusNoContent, rec.Code)
		})
	})

	t.Run("login_rate_limit", func(t *testing.T) {
		server, client := newTestAPI(t)
		bootstrapOnly(t, client, server.URL)

		failLogin := func() int {
			code, _ := callJSON[struct{}](t, client, server.URL, http.MethodPost, "/api/auth/login",
				map[string]any{"username": "jent", "password": "wrong"})
			return code
		}

		for i := 0; i < loginFailuresAllowed; i++ {
			require.Equal(t, http.StatusUnauthorized, failLogin())
		}

		code, body := callJSON[errorBody](t, client, server.URL, http.MethodPost, "/api/auth/login",
			map[string]any{"username": "jent", "password": "wrong"})
		assert.Equal(t, http.StatusTooManyRequests, code)
		assert.Equal(t, "rate_limited", body.Error)

		// the right password is refused too: the budget is spent
		code, _ = callJSON[struct{}](t, client, server.URL, http.MethodPost, "/api/auth/login",
			map[string]any{"username": "jent", "password": "hunter2"})
		assert.Equal(t, http.StatusTooManyRequests, code)
	})

	t.Run("success_resets_budget", func(t *testing.T) {
		server, client := newTestAPI(t)
		bootstrapOnly(t, client, server.URL)

		burn := func() {
			for i := 0; i < loginFailuresAllowed-1; i++ {
				code, _ := callJSON[struct{}](t, client, server.URL, http.MethodPost, "/api/auth/login",
					map[string]any{"username": "jent", "password": "wrong"})
				require.Equal(t, http.StatusUnauthorized, code)
			}
		}

		burn()
		code, _ := callJSON[struct{}](t, client, server.URL, http.MethodPost, "/api/auth/login",
			map[string]any{"username": "jent", "password": "hunter2"})
		require.Equal(t, http.StatusNoContent, code)

		// the budget restarted: a second run of failures stays below the cap
		burn()
		code, _ = callJSON[struct{}](t, client, server.URL, http.MethodPost, "/api/auth/login",
			map[string]any{"username": "jent", "password": "wrong"})
		assert.Equal(t, http.StatusUnauthorized, code)
	})

	t.Run("bootstrap_rate_limited", func(t *testing.T) {
		server, client := newTestAPI(t)

		// every bootstrap attempt spends budget (bcrypt cost is the DoS vector),
		// and a success resets it: one 204 then repeated 409s exhaust the cap
		code, _ := callJSON[struct{}](t, client, server.URL, http.MethodPost, "/api/auth/bootstrap",
			map[string]string{"password": "hunter2"})
		require.Equal(t, http.StatusNoContent, code)
		for i := 0; i < loginFailuresAllowed; i++ {
			code, _ = callJSON[struct{}](t, client, server.URL, http.MethodPost, "/api/auth/bootstrap",
				map[string]string{"password": fmt.Sprintf("other-%d", i)})
			require.Equal(t, http.StatusConflict, code)
		}

		code, body := callJSON[errorBody](t, client, server.URL, http.MethodPost, "/api/auth/bootstrap",
			map[string]string{"password": "one-more"})
		assert.Equal(t, http.StatusTooManyRequests, code)
		assert.Equal(t, "rate_limited", body.Error)
	})
}

func TestSecureCookie(t *testing.T) {
	t.Run("secure_through_proxy_header", func(t *testing.T) {
		server, client := newTestAPI(t)
		base := server.URL

		bootstrapAndLogin(t, client, base)

		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, base+"/api/auth/login",
			jsonBody(map[string]any{"username": "jent", "password": "hunter2"}))
		require.NoError(t, err)
		req.Header.Set("X-Forwarded-Proto", "https")
		resp, err := client.Do(req)
		require.NoError(t, err)
		t.Cleanup(func() { _ = resp.Body.Close() })
		require.Equal(t, http.StatusNoContent, resp.StatusCode)
		assert.True(t, cookieFrom(resp).Secure)

		// a plain http forwarded proto does not mark the cookie
		req2, err := http.NewRequestWithContext(t.Context(), http.MethodPost, base+"/api/auth/login",
			jsonBody(map[string]any{"username": "jent", "password": "hunter2"}))
		require.NoError(t, err)
		req2.Header.Set("X-Forwarded-Proto", "http")
		resp2, err := client.Do(req2)
		require.NoError(t, err)
		t.Cleanup(func() { _ = resp2.Body.Close() })
		assert.False(t, cookieFrom(resp2).Secure)
	})

	t.Run("secure_over_direct_tls", func(t *testing.T) {
		server := httptest.NewUnstartedServer(Handler(Config{
			Auth:  newTestService(t),
			Fleet: newTestFleet(t),
			Log:   testLogger(),
		}))
		server.TLS = &tls.Config{} //nolint:gosec // test-only self-signed serving
		server.StartTLS()
		t.Cleanup(server.Close)

		jar, err := cookiejar.New(nil)
		require.NoError(t, err)
		client := server.Client()
		client.Jar = jar
		bootstrapAndLogin(t, client, server.URL)

		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, server.URL+"/api/auth/login",
			jsonBody(map[string]any{"username": "jent", "password": "hunter2"}))
		require.NoError(t, err)
		resp, err := client.Do(req)
		require.NoError(t, err)
		t.Cleanup(func() { _ = resp.Body.Close() })
		assert.True(t, cookieFrom(resp).Secure)
	})

	t.Run("plain_http_unmarked", func(t *testing.T) {
		server, client := newTestAPI(t)
		base := server.URL
		bootstrapAndLogin(t, client, base)

		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, base+"/api/auth/login",
			jsonBody(map[string]any{"username": "jent", "password": "hunter2"}))
		require.NoError(t, err)
		resp, err := client.Do(req)
		require.NoError(t, err)
		t.Cleanup(func() { _ = resp.Body.Close() })
		assert.False(t, cookieFrom(resp).Secure)

		// the clear-cookie path marks Secure on the same rule
		req2, err := http.NewRequestWithContext(t.Context(), http.MethodPost, base+"/api/auth/logout", nil)
		require.NoError(t, err)
		resp2, err := client.Do(req2)
		require.NoError(t, err)
		t.Cleanup(func() { _ = resp2.Body.Close() })
		assert.False(t, cookieFrom(resp2).Secure)
	})
}

// bootstrapOnly brings a fresh service past bootstrap without signing in.
func bootstrapOnly(t *testing.T, client *http.Client, baseURL string) {
	t.Helper()
	code, _ := callJSON[struct{}](t, client, baseURL, http.MethodPost, "/api/auth/bootstrap",
		map[string]string{"password": "hunter2"})
	require.Equal(t, http.StatusNoContent, code)
}

func jsonBody(v any) io.Reader {
	raw, err := json.Marshal(v)
	if err != nil {
		panic("test body: " + err.Error())
	}
	return bytes.NewReader(raw)
}

func cookieFrom(resp *http.Response) *http.Cookie {
	for _, c := range resp.Cookies() {
		if c.Name == auth.SessionCookieName {
			return c
		}
	}
	return nil
}
