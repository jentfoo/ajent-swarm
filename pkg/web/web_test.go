package web

import (
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/go-analyze/bulk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// assetRefRe pulls the absolute asset references out of the served document,
// so the test tracks whatever the build emitted instead of pinned names.
var assetRefRe = regexp.MustCompile(`(?:src|href)="(/[^"]+)"`)

// scriptOpenRe matches every opening <script ...> tag in the document.
var scriptOpenRe = regexp.MustCompile(`<script([^>]*)>`)

// themeScriptRe captures the body of the inline theme-bootstrap script.
var themeScriptRe = regexp.MustCompile(`(?s)<script id="theme-bootstrap">(.*?)</script>`)

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

	t.Run("csp_scoped_to_documents", func(t *testing.T) {
		tests := []struct {
			name    string
			path    string
			wantCSP bool
		}{
			{name: "root_document", path: "/", wantCSP: true},
			{name: "direct_index_request", path: "/index.html", wantCSP: true},
			{name: "spa_route_fallback", path: "/sessions/abc", wantCSP: true},
			{name: "directory_style_route", path: "/sessions/", wantCSP: true},
			{name: "asset_skips_policy", path: "/favicon.svg"},
			{name: "missing_asset_skips_policy", path: "/nope.js"},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, tt.path, nil)
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, req)

				csp := rec.Header().Get("Content-Security-Policy")
				if tt.wantCSP {
					assert.Equal(t, contentSecurityPolicy, csp)
				} else {
					assert.Empty(t, csp)
				}
			})
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

func TestContentSecurityPolicy(t *testing.T) {
	t.Parallel()

	doc, err := distFS.ReadFile("dist/" + indexHTML)
	require.NoError(t, err)

	// recomputes the hash from the embedded document so a frontend edit that
	// changes the inline script fails here instead of shipping a policy the
	// browser silently refuses
	opens := scriptOpenRe.FindAllStringSubmatch(string(doc), -1)
	inlineOpens := bulk.SliceFilter(func(open []string) bool {
		return !strings.Contains(open[1], "src=")
	}, opens)
	require.Len(t, inlineOpens, 1)

	matches := themeScriptRe.FindAllSubmatch(doc, -1)
	require.Len(t, matches, 1)
	sum := sha256.Sum256(matches[0][1])
	hash := "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	assert.Contains(t, contentSecurityPolicy, hash)
}
