package api

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent-swarm/pkg/auth"
)

func TestSecureCookie(t *testing.T) {
	t.Run("secure through proxy header", func(t *testing.T) {
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

	t.Run("secure over direct tls", func(t *testing.T) {
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

	t.Run("plain http unmarked", func(t *testing.T) {
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
