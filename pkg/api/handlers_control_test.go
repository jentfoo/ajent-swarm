package api

import (
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent/pkg/ctl"
)

func TestSessionControl(t *testing.T) {
	t.Run("models endpoint", func(t *testing.T) {
		h := newSessionAPI(t)
		f := h.addSession("01MODELS00000000000", fleettest.Options{})
		f.Result(ctl.MethodModelsGet, ctl.ModelsData{
			Active: "anthropic/claude-sonnet",
			Models: []ctl.ModelState{{Key: "anthropic/claude-sonnet", Short: "sonnet", Window: 200000}},
		})

		code, got := get[ctl.ModelsData](h, "/api/sessions/"+f.SessionID()+"/models")
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, "anthropic/claude-sonnet", got.Active)
		require.Len(t, got.Models, 1)
		assert.Equal(t, "sonnet", got.Models[0].Short)

		// unknown sessions refuse before dialing
		code, _ = get[struct{}](h, "/api/sessions/01NOBODY00000000/models")
		assert.Equal(t, http.StatusNotFound, code)
	})

	t.Run("model set endpoint", func(t *testing.T) {
		h := newSessionAPI(t)
		f := h.addSession("01MODELSET0000000000", fleettest.Options{})
		f.Result(ctl.MethodModelSet, ctl.ModelSetResult{
			Model: ctl.ModelState{Key: "anthropic/claude-haiku", Short: "haiku"},
		})

		code, got := post[struct {
			Model string `json:"model"`
		}](h, "/api/sessions/"+f.SessionID()+"/model", map[string]string{"model": "haiku"})
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, "anthropic/claude-haiku", got.Model)

		var setReq fleettest.RecordedRequest
		for _, req := range f.Received() {
			if req.Method == ctl.MethodModelSet {
				setReq = req
			}
		}
		require.NotNil(t, setReq.Params)
		assert.JSONEq(t, `{"model":"haiku"}`, string(setReq.Params))

		// empty names are bad-request before any dialing
		code, _ = post[struct{}](h, "/api/sessions/"+f.SessionID()+"/model", map[string]string{})
		assert.Equal(t, http.StatusBadRequest, code)
	})

	t.Run("tools endpoint", func(t *testing.T) {
		h := newSessionAPI(t)
		f := h.addSession("01TOOLS000000000000", fleettest.Options{})
		f.Result(ctl.MethodToolsSet, ctl.ToolsSetResult{Rows: []ctl.ToolState{
			{Name: "read_file", Enabled: true},
		}})

		code, got := post[struct {
			Rows []ctl.ToolState `json:"rows"`
		}](h, "/api/sessions/"+f.SessionID()+"/tools", map[string]any{"names": []string{"read_file"}})
		require.Equal(t, http.StatusOK, code)
		require.Len(t, got.Rows, 1)
		assert.True(t, got.Rows[0].Enabled)

		var setReq fleettest.RecordedRequest
		for _, req := range f.Received() {
			if req.Method == ctl.MethodToolsSet {
				setReq = req
			}
		}
		require.NotNil(t, setReq.Params)
		assert.JSONEq(t, `{"names":["read_file"]}`, string(setReq.Params))
	})

	t.Run("settings endpoints", func(t *testing.T) {
		h := newSessionAPI(t)
		f := h.addSession("01SETTINGS0000000000", fleettest.Options{})
		f.Result(ctl.MethodSettingsGet, ctl.SettingsData{Rows: []ctl.SettingRow{
			{Label: "Theme", Key: "theme", Value: []byte(`"dark"`), Source: "user", Editable: true},
		}})
		f.Result(ctl.MethodSettingsSet, ctl.SettingsSetResult{Row: ctl.SettingRow{
			Label: "Theme", Key: "theme", Value: []byte(`"light"`), Source: "session", Editable: true,
		}})

		code, got := get[struct {
			Rows []ctl.SettingRow `json:"rows"`
		}](h, "/api/sessions/"+f.SessionID()+"/settings")
		require.Equal(t, http.StatusOK, code)
		require.Len(t, got.Rows, 1)
		assert.Equal(t, "theme", got.Rows[0].Key)

		code, applied := post[struct {
			Row ctl.SettingRow `json:"row"`
		}](h, "/api/sessions/"+f.SessionID()+"/setting",
			map[string]any{"key": "theme", "value": "light"})
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, "session", applied.Row.Source)

		// a missing key is bad-request before any dialing
		code, _ = post[struct{}](h, "/api/sessions/"+f.SessionID()+"/setting",
			map[string]any{"value": true})
		assert.Equal(t, http.StatusBadRequest, code)
	})

	t.Run("title writes swarm storage", func(t *testing.T) {
		h := newSessionAPI(t)
		f := h.addSession("01TITLEDROW0000000", fleettest.Options{})

		code, _ := post[struct{}](h, "/api/sessions/"+f.SessionID()+"/title",
			map[string]string{"title": "  couch reading  "})
		require.Equal(t, http.StatusNoContent, code)
		titles, err := h.st.SessionTitles(t.Context())
		require.NoError(t, err)
		assert.Equal(t, map[string]string{f.SessionID(): "couch reading"}, titles)

		// the listing carries the stored title beside the name and path facts
		code, rows := get[[]struct {
			SessionID string `json:"sessionId"`
			Title     string `json:"title"`
			Name      string `json:"name"`
		}](h, "/api/sessions")
		require.Equal(t, http.StatusOK, code)
		var titled bool
		for _, row := range rows {
			if row.SessionID == f.SessionID() {
				titled = true
				assert.Equal(t, "couch reading", row.Title)
				assert.Empty(t, row.Name)
			}
		}
		assert.True(t, titled)

		// clearing and whitespace-only titles delete the row instead of storing
		// blank labels, so labels fall back to names and paths everywhere
		for _, body := range []string{"", "   "} {
			code, _ = post[struct{}](h, "/api/sessions/"+f.SessionID()+"/title",
				map[string]string{"title": body})
			require.Equal(t, http.StatusNoContent, code)
		}
		titles, err = h.st.SessionTitles(t.Context())
		require.NoError(t, err)
		assert.Empty(t, titles)

		// an empty session id is a usage error, never a stored row
		code, _ = post[struct{}](h, "/api/sessions/%20/title", map[string]string{"title": "x"})
		require.Equal(t, http.StatusBadRequest, code)
	})

	t.Run("title without store refused", func(t *testing.T) {
		// a manager without a title store refuses renames loudly at the API too
		mgr := fleet.New(fleet.Options{
			Log:      testLogger(),
			Discover: func() ([]ctl.Instance, error) { return nil, nil },
		})
		mgr.Start(t.Context())
		t.Cleanup(mgr.Stop)

		server := httptest.NewServer(Handler(Config{Auth: newTestService(t), Fleet: mgr, Log: testLogger()}))
		t.Cleanup(server.Close)

		jar, err := cookiejar.New(nil)
		require.NoError(t, err)
		client := &http.Client{Jar: jar}
		bootstrapAndLogin(t, client, server.URL)

		code, _ := callJSON[struct{}](t, client, server.URL, http.MethodPost,
			"/api/sessions/01ANYSESSION000000/title", map[string]string{"title": "x"})
		assert.Equal(t, http.StatusInternalServerError, code)
	})
}
