package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newGate builds a gated mux with one exempt route and two protected routes
// (one read, one write).
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
	mux.HandleFunc(http.MethodPost+" /api/jobs", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	return svc, svc.Middleware(exempt)(mux)
}

func TestMiddleware(t *testing.T) {
	t.Parallel()

	t.Run("pending_gate_marks_every_route", func(t *testing.T) {
		_, handler := newGate(t)

		t.Run("bootstrap_required_everywhere", func(t *testing.T) {
			for _, path := range []string{"/api/secret", "/api/me"} {
				req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil)
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, req)

				assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
				var body map[string]string
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
				assert.Equal(t, "bootstrap_required", body["error"])
			}
		})

		t.Run("bootstrap_endpoint_passes_while_pending", func(t *testing.T) {
			req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, BootstrapPath, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusNoContent, rec.Code)
		})
	})

	t.Run("after_bootstrap", func(t *testing.T) {
		svc, handler := newGate(t)
		ctx := t.Context()
		require.NoError(t, svc.SetPassword(ctx, "hunter2"))

		t.Run("anonymous_request_refused", func(t *testing.T) {
			req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/secret", nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusUnauthorized, rec.Code)
		})

		t.Run("session_cookie_authenticates", func(t *testing.T) {
			token, err := svc.Login(ctx, "jent", "hunter2")
			require.NoError(t, err)

			req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/secret", nil)
			req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: token})
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusNoContent, rec.Code)
		})

		t.Run("fresh_bearer_authenticates", func(t *testing.T) {
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
	})

	t.Run("cross_site_write_blocked", func(t *testing.T) {
		for _, tc := range []struct {
			name    string
			method  string
			site    string // Sec-Fetch-Site value, empty when the header is absent
			blocked bool
		}{
			{"post_absent_allowed", http.MethodPost, "", false},
			{"post_same_origin_allowed", http.MethodPost, "same-origin", false},
			{"post_none_allowed", http.MethodPost, "none", false},
			{"post_cross_site_blocked", http.MethodPost, "cross-site", true},
			{"post_same_site_blocked", http.MethodPost, "same-site", true},
			{"put_cross_site_blocked", http.MethodPut, "cross-site", true},
			{"delete_cross_site_blocked", http.MethodDelete, "cross-site", true},
			{"patch_cross_site_blocked", http.MethodPatch, "cross-site", true},
			{"get_cross_site_allowed", http.MethodGet, "cross-site", false},
			{"head_cross_site_allowed", http.MethodHead, "cross-site", false},
			{"options_cross_site_allowed", http.MethodOptions, "cross-site", false},
		} {
			t.Run(tc.name, func(t *testing.T) {
				req := httptest.NewRequestWithContext(t.Context(), tc.method, "/api/jobs", nil)
				if tc.site != "" {
					req.Header.Set("Sec-Fetch-Site", tc.site)
				}
				assert.Equal(t, tc.blocked, crossSiteWriteBlocked(req))
			})
		}
	})

	t.Run("middleware_cross_site", func(t *testing.T) {
		svc, handler := newGate(t)
		ctx := t.Context()
		require.NoError(t, svc.SetPassword(ctx, "hunter2"))
		sessionToken, err := svc.Login(ctx, "jent", "hunter2")
		require.NoError(t, err)

		// postWithSite posts /api/jobs with the session cookie and Sec-Fetch-Site.
		postWithSite := func(site string) *httptest.ResponseRecorder {
			req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/jobs", nil)
			req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: sessionToken})
			if site != "" {
				req.Header.Set("Sec-Fetch-Site", site)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			return rec
		}

		t.Run("cross_site_post_refused", func(t *testing.T) {
			rec := postWithSite("cross-site")
			assert.Equal(t, http.StatusForbidden, rec.Code)
			var body map[string]string
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			assert.Equal(t, "cross_site_blocked", body["error"])
		})

		t.Run("same_site_post_refused", func(t *testing.T) {
			rec := postWithSite("same-site")
			assert.Equal(t, http.StatusForbidden, rec.Code)
		})

		t.Run("absent_header_passes", func(t *testing.T) {
			assert.Equal(t, http.StatusNoContent, postWithSite("").Code)
		})

		t.Run("none_passes", func(t *testing.T) {
			assert.Equal(t, http.StatusNoContent, postWithSite("none").Code)
		})

		t.Run("bearer_cross_site_passes", func(t *testing.T) {
			token, err := svc.CreateToken(ctx, "ci")
			require.NoError(t, err)

			req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/jobs", nil)
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Sec-Fetch-Site", "cross-site")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusNoContent, rec.Code)
		})

		t.Run("get_cross_site_passes", func(t *testing.T) {
			req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/secret", nil)
			req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: sessionToken})
			req.Header.Set("Sec-Fetch-Site", "cross-site")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusNoContent, rec.Code)
		})
	})
}
