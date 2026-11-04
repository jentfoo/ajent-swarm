package api

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"

	"github.com/jentfoo/ajent-swarm/pkg/auth"
	"github.com/jentfoo/ajent-swarm/pkg/store"
)

// newTestAPIWithAttachments is newTestAPI plus a wired attachments directory,
// returned beside the server so tests can assert where bytes landed.
func newTestAPIWithAttachments(t *testing.T) (server *httptest.Server, client *http.Client, dir string) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), store.FileName))
	require.NoError(t, err)
	t.Cleanup(func() { _ = st.Close() })

	svc, err := auth.NewService(st, auth.WithBcryptCost(bcrypt.MinCost))
	require.NoError(t, err)
	require.NoError(t, svc.EnsureUser(t.Context(), "jent"))

	dir = t.TempDir()
	server = httptest.NewServer(Handler(Config{
		Auth:           svc,
		Fleet:          newTestFleet(t),
		AttachmentsDir: dir,
		Log:            testLogger(),
	}))
	t.Cleanup(server.Close)

	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	return server, &http.Client{Jar: jar}, dir
}

// postAttachment uploads one file field and returns the response beside its
// decoded JSON body.
func postAttachment(t *testing.T, client *http.Client, baseURL, sessionID string,
	fileName string, body []byte,
) (*http.Response, map[string]any) {
	t.Helper()

	var payload bytes.Buffer
	w := multipart.NewWriter(&payload)
	fw, err := w.CreateFormFile("file", fileName)
	require.NoError(t, err)
	_, err = fw.Write(body)
	require.NoError(t, err)
	require.NoError(t, w.Close())

	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
		baseURL+"/api/sessions/"+sessionID+"/attachments", &payload)
	require.NoError(t, err)
	req.Header.Set("Content-Type", w.FormDataContentType())

	resp, err := client.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })

	var out map[string]any
	err = json.NewDecoder(resp.Body).Decode(&out)
	if err != nil && resp.StatusCode != http.StatusNoContent {
		require.NoError(t, err)
	}
	return resp, out
}
func TestSessionAttachments(t *testing.T) {
	t.Run("upload stores bytes under state dir", func(t *testing.T) {
		server, client, dir := newTestAPIWithAttachments(t)
		bootstrapAndLogin(t, client, server.URL)

		resp, body := postAttachment(t, client, server.URL, "01ABC", "photo.png", []byte("fake png bytes"))
		require.Equal(t, http.StatusCreated, resp.StatusCode)

		path, ok := body["path"].(string)
		require.True(t, ok)
		assert.True(t, filepath.IsAbs(path))
		assert.Equal(t, ".png", filepath.Ext(path))

		raw, err := os.ReadFile(path)
		require.NoError(t, err)
		assert.Equal(t, []byte("fake png bytes"), raw)

		info, statErr := os.Stat(path)
		require.NoError(t, statErr)
		assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())

		sessionDir := filepath.Dir(path)
		assert.Equal(t, "01ABC", filepath.Base(sessionDir))
		assert.True(t, strings.HasPrefix(sessionDir, dir))
	})

	t.Run("drops hostile names", func(t *testing.T) {
		server, client, _ := newTestAPIWithAttachments(t)
		bootstrapAndLogin(t, client, server.URL)

		resp, body := postAttachment(t, client, server.URL, "01ABC", "../../etc/passwd", []byte("x"))
		require.Equal(t, http.StatusCreated, resp.StatusCode)
		path := body["path"].(string)
		assert.Empty(t, filepath.Ext(path))
		assert.NotContains(t, path, "..")

		// URL traversal never reaches the handler (the fetcher and mux normalize
		// it away), so the session-id sanitizer is covered directly below: every
		// separator and dot-segment reduces into one contained element.
		assert.Equal(t, "etc", sanitizeAttachmentName("../../etc"))
		assert.Equal(t, "swarm-state", sanitizeAttachmentName("../../swarm-state"))
		assert.Equal(t, "01-ABC_2", sanitizeAttachmentName("../01-ABC_2/"))
	})

	t.Run("rejects bad requests", func(t *testing.T) {
		server, client, _ := newTestAPIWithAttachments(t)
		bootstrapAndLogin(t, client, server.URL)

		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
			server.URL+"/api/sessions/01ABC/attachments", bytes.NewReader([]byte("not multipart")))
		req.Header.Set("Content-Type", "text/plain")
		require.NoError(t, err)
		resp, err := client.Do(req)
		require.NoError(t, err)
		t.Cleanup(func() { _ = resp.Body.Close() })
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("name keeps only extension", func(t *testing.T) {
		now := time.Now()
		name := attachmentName(now, "shot.PNG")
		assert.Regexp(t, `^\d{8}-\d{6}-[0-9a-f]{16}\.PNG$`, name)

		// A hostile or overlong extension reduces to word characters.
		assert.Empty(t, sanitizeAttachmentExt("....//"))
		assert.Equal(t, "png", sanitizeAttachmentExt(".p/n/g?."))
	})

	t.Run("sanitize empty edge cases", func(t *testing.T) {
		for _, in := range []string{"", ".", "..", "/"} {
			assert.Empty(t, sanitizeAttachmentName(in))
		}
		assert.Equal(t, "a.b.c", sanitizeAttachmentName(" a.b.c "))
	})
}
