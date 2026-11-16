package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTokenHandlers(t *testing.T) {
	t.Parallel()

	// each case runs against its own server so ordering cannot matter
	newAuthed := func(t *testing.T) (string, *http.Client) {
		t.Helper()
		server, client := newTestAPI(t)
		bootstrapAndLogin(t, client, server.URL)
		return server.URL, client
	}

	t.Run("create_returns_the_secret_once", func(t *testing.T) {
		base, client := newAuthed(t)

		code, body := callJSON[map[string]string](t, client, base,
			http.MethodPost, "/api/tokens", map[string]string{"name": "ci"})
		require.Equal(t, http.StatusCreated, code)
		assert.NotEmpty(t, body["token"])
		assert.True(t, strings.HasPrefix(body["token"], "swt_"))

		code, _ = callJSON[map[string]string](t, client, base,
			http.MethodPost, "/api/tokens", map[string]string{"name": "ci"})
		assert.Equal(t, http.StatusConflict, code)
	})

	t.Run("list_omits_secrets", func(t *testing.T) {
		base, client := newAuthed(t)
		code, _ := callJSON[map[string]string](t, client, base,
			http.MethodPost, "/api/tokens", map[string]string{"name": "ci"})
		require.Equal(t, http.StatusCreated, code)

		code, body := callJSON[[]map[string]any](t, client, base, http.MethodGet, "/api/tokens", nil)
		require.Equal(t, http.StatusOK, code)
		require.Len(t, body, 1)
		assert.Equal(t, "ci", body[0]["name"])
		assert.NotContains(t, body[0], "token")
	})

	t.Run("invalid_names_rejected", func(t *testing.T) {
		base, client := newAuthed(t)

		code, _ := callJSON[struct{}](t, client, base,
			http.MethodPost, "/api/tokens", map[string]string{"name": "has space"})
		assert.Equal(t, http.StatusBadRequest, code)
	})

	t.Run("delete_revokes", func(t *testing.T) {
		base, client := newAuthed(t)
		code, _ := callJSON[map[string]string](t, client, base,
			http.MethodPost, "/api/tokens", map[string]string{"name": "ci"})
		require.Equal(t, http.StatusCreated, code)

		code, _ = callJSON[struct{}](t, client, base, http.MethodDelete, "/api/tokens/ci", nil)
		require.Equal(t, http.StatusNoContent, code)

		code, _ = callJSON[struct{}](t, client, base, http.MethodDelete, "/api/tokens/ci", nil)
		assert.Equal(t, http.StatusNotFound, code)
	})
}
