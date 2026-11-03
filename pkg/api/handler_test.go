package api

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHandler(t *testing.T) {
	t.Parallel()

	t.Run("bearer_auth_works_across_clients", func(t *testing.T) {
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
		t.Cleanup(func() { _ = resp.Body.Close() })
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		// a garbage secret must not authenticate
		req2, err := http.NewRequestWithContext(t.Context(), http.MethodGet, base+"/api/tokens", nil)
		require.NoError(t, err)
		req2.Header.Set("Authorization", "Bearer swt_bogus")
		resp2, err := scriptClient.Do(req2)
		require.NoError(t, err)
		t.Cleanup(func() { _ = resp2.Body.Close() })
		assert.Equal(t, http.StatusUnauthorized, resp2.StatusCode)
	})

	t.Run("route_behaviors", func(t *testing.T) {
		server, client := newTestAPI(t)
		base := server.URL

		t.Run("unknown_api_path_404", func(t *testing.T) {
			bootstrapAndLogin(t, client, base)
			code, body := callJSON[map[string]string](t, client, base, http.MethodGet, "/api/nope", nil)
			assert.Equal(t, http.StatusNotFound, code)
			assert.Equal(t, "not_found", body["error"])
		})

		t.Run("method_mismatch_is_a_405", func(t *testing.T) {
			code, _ := callJSON[struct{}](t, client, base, http.MethodGet, "/api/auth/login", nil)
			assert.Equal(t, http.StatusMethodNotAllowed, code)
		})
	})

	t.Run("security_headers", func(t *testing.T) {
		t.Run("baseline_on_api_and_static", func(t *testing.T) {
			server, client := newTestAPI(t)
			base := server.URL

			tests := []struct {
				name string
				path string
			}{
				{name: "api_error_response", path: "/api/sessions"}, // 401 without login
				{name: "static_document", path: "/"},
				{name: "static_asset", path: "/favicon.svg"},
			}
			for _, tt := range tests {
				t.Run(tt.name, func(t *testing.T) {
					resp := call(t, client, base, http.MethodGet, tt.path, nil)
					assert.Equal(t, "nosniff", resp.Header.Get("X-Content-Type-Options"))
					assert.Equal(t, "no-referrer", resp.Header.Get("Referrer-Policy"))
					assert.Equal(t, "DENY", resp.Header.Get("X-Frame-Options"))
				})
			}
		})

		t.Run("api_responses_are_no_store", func(t *testing.T) {
			server, client := newTestAPI(t)
			base := server.URL
			bootstrapAndLogin(t, client, base)

			resp := call(t, client, base, http.MethodGet, "/api/sessions", nil)
			require.Equal(t, http.StatusOK, resp.StatusCode)
			assert.Equal(t, "no-store", resp.Header.Get("Cache-Control"))

			static := call(t, client, base, http.MethodGet, "/", nil)
			assert.Equal(t, "no-cache", static.Header.Get("Cache-Control"))
		})
	})
}
