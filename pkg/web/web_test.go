package web

import (
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// assetRefRe pulls the absolute asset references out of the served document,
// so the test tracks whatever the build emitted instead of pinned names.
var assetRefRe = regexp.MustCompile(`(?:src|href)="(/[^"]+)"`)

func TestHandler(t *testing.T) {
	t.Parallel()

	handler := Handler()

	t.Run("serves_documents_and_assets", func(t *testing.T) {
		tests := []struct {
			name       string
			path       string
			method     string
			wantStatus int
			wantType   string // expected Content-Type prefix, empty to skip
			wantBody   string // substring of the body when set
		}{
			{name: "root_serves_index", path: "/", wantStatus: 200, wantType: "text/html", wantBody: "<!doctype html>"},
			{name: "spa_route_falls_back", path: "/sessions/abc", wantStatus: 200, wantType: "text/html", wantBody: "<!doctype html>"},
			{name: "directory_style_spa_route", path: "/sessions/", wantStatus: 200, wantType: "text/html", wantBody: "<!doctype html>"},
			{name: "favicon_served", path: "/favicon.svg", wantStatus: 200, wantType: "image/svg"},
			{name: "missing_asset_not_found", path: "/nope.js", wantStatus: 404},
			{name: "traversal_stays_contained", path: "/../pkg/auth/auth.go", wantStatus: 404},
			{name: "post_rejected", path: "/", method: http.MethodPost, wantStatus: 405},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				method := tt.method
				if method == "" {
					method = http.MethodGet
				}
				req := httptest.NewRequestWithContext(t.Context(), method, tt.path, nil)
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, req)

				assert.Equal(t, tt.wantStatus, rec.Code)
				if tt.wantType != "" {
					assert.True(t, strings.HasPrefix(rec.Header().Get("Content-Type"), tt.wantType))
				}
				if tt.wantBody != "" {
					body, err := io.ReadAll(rec.Body)
					require.NoError(t, err)
					assert.Contains(t, string(body), tt.wantBody)
				}
			})
		}
	})

	t.Run("document_asset_references_resolve", func(t *testing.T) {
		req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		body, err := io.ReadAll(rec.Body)
		require.NoError(t, err)
		refs := assetRefRe.FindAllStringSubmatch(string(body), -1)
		require.NotEmpty(t, refs)

		for _, ref := range refs {
			assetReq := httptest.NewRequestWithContext(t.Context(), http.MethodGet, ref[1], nil)
			assetRec := httptest.NewRecorder()
			handler.ServeHTTP(assetRec, assetReq)
			assert.Equal(t, http.StatusOK, assetRec.Code)
			contentType := assetRec.Header().Get("Content-Type")
			assert.NotContains(t, contentType, "text/html")
		}
	})

	t.Run("head_carries_no_body", func(t *testing.T) {
		req := httptest.NewRequestWithContext(t.Context(), http.MethodHead, "/", nil)
		rec := httptest.NewRecorder()
		Handler().ServeHTTP(rec, req)

		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Empty(t, rec.Body.Bytes())
	})
}
