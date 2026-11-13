package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestReadRequest(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		body       string
		wantOK     bool
		wantStatus int
		wantCode   string
		wantLine   string
	}{
		{name: "decodes_a_strict_body", body: `{"line":"hi"}`, wantOK: true, wantLine: "hi"},
		{name: "unknown_field_rejected", body: `{"line":"hi","typo":1}`,
			wantStatus: http.StatusBadRequest, wantCode: "invalid_request"},
		{name: "garbage_rejected", body: `not json`,
			wantStatus: http.StatusBadRequest, wantCode: "invalid_request"},
		{name: "missing_body_rejected", body: ``,
			wantStatus: http.StatusBadRequest, wantCode: "invalid_request"},
		{name: "oversize_rejected", body: `{"line":"` + strings.Repeat("x", maxBodyBytes) + `"}`,
			wantStatus: http.StatusRequestEntityTooLarge, wantCode: "body_too_large"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var dst struct {
				Line string `json:"line"`
			}
			rec := httptest.NewRecorder()
			req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/", strings.NewReader(tt.body))

			ok := readRequest(rec, req, &dst)

			require.Equal(t, tt.wantOK, ok)
			if !tt.wantOK {
				assert.Equal(t, tt.wantStatus, rec.Code)
				assert.Contains(t, rec.Body.String(), tt.wantCode)
				return
			}
			assert.Equal(t, tt.wantLine, dst.Line)
		})
	}
}

func TestReadOptionalRequest(t *testing.T) {
	t.Parallel()

	var dst struct {
		Line string `json:"line"`
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/", nil)

	ok := readOptionalRequest(rec, req, &dst)

	assert.True(t, ok)
	assert.Empty(t, dst.Line)
	assert.Empty(t, rec.Body.String()) // nothing written, the handler answers
}
