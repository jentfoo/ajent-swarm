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

	tests := []struct {
		name       string
		path       string
		method     string
		wantStatus int
		wantType   string // expected Content-Type prefix, empty to skip
		wantBody   string // substring of the body when set
	}{
		{name: "root serves index", path: "/", wantStatus: 200, wantType: "text/html", wantBody: "<!doctype html>"},
		{name: "spa route falls back", path: "/sessions/abc", wantStatus: 200, wantType: "text/html", wantBody: "<!doctype html>"},
		{name: "directory style spa route", path: "/sessions/", wantStatus: 200, wantType: "text/html", wantBody: "<!doctype html>"},
		{name: "favicon served", path: "/favicon.svg", wantStatus: 200, wantType: "image/svg"},
		{name: "missing asset not found", path: "/nope.js", wantStatus: 404},
		{name: "traversal stays contained", path: "/../pkg/auth/auth.go", wantStatus: 404},
		{name: "post rejected", path: "/", method: http.MethodPost, wantStatus: 405},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			method := tt.method
			if method == "" {
				method = http.MethodGet
			}
			req := httptest.NewRequestWithContext(t.Context(), method, tt.path, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)
			if tt.wantType != "" {
				assert.True(t, strings.HasPrefix(rec.Header().Get("Content-Type"), tt.wantType),
					"content type %q", rec.Header().Get("Content-Type"))
			}
			if tt.wantBody != "" {
				body, err := io.ReadAll(rec.Body)
				require.NoError(t, err)
				assert.Contains(t, string(body), tt.wantBody)
			}
		})
	}

	t.Run("document asset references resolve", func(t *testing.T) {
		t.Parallel()

		req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		body, err := io.ReadAll(rec.Body)
		require.NoError(t, err)
		refs := assetRefRe.FindAllStringSubmatch(string(body), -1)
		require.NotEmpty(t, refs, "the document references its build output")

		for _, ref := range refs {
			assetReq := httptest.NewRequestWithContext(t.Context(), http.MethodGet, ref[1], nil)
			assetRec := httptest.NewRecorder()
			handler.ServeHTTP(assetRec, assetReq)
			assert.Equal(t, http.StatusOK, assetRec.Code, "asset %s", ref[1])
			contentType := assetRec.Header().Get("Content-Type")
			assert.NotContains(t, contentType, "text/html", "asset %s", ref[1])
		}
	})
}

func TestHandlerHead(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequestWithContext(t.Context(), http.MethodHead, "/", nil)
	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Empty(t, rec.Body.Bytes(), "HEAD carries no body")
}
