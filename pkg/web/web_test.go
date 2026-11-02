package web

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

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
		{name: "script asset served", path: "/app.js", wantStatus: 200, wantType: "text/javascript"},
		{name: "style asset served", path: "/app.css", wantStatus: 200, wantType: "text/css"},
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
}

func TestHandlerHead(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequestWithContext(t.Context(), http.MethodHead, "/", nil)
	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Empty(t, rec.Body.Bytes(), "HEAD carries no body")
}
