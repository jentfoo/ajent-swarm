package api

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent/pkg/ctl"
)

func TestSettingsHandlers(t *testing.T) {
	t.Run("global_settings_endpoints", func(t *testing.T) {
		t.Run("default_ships_unset", func(t *testing.T) {
			h := newSessionAPI(t)

			code, got := get[struct {
				TitleModel string `json:"titleModel"`
			}](h, "/api/settings")
			require.Equal(t, http.StatusOK, code)
			assert.Empty(t, got.TitleModel)
		})

		t.Run("put_trims_the_model", func(t *testing.T) {
			h := newSessionAPI(t)

			code, got := put[struct {
				TitleModel string `json:"titleModel"`
			}](h, "/api/settings", map[string]string{"titleModel": " namer-model "})
			require.Equal(t, http.StatusOK, code)
			assert.Equal(t, "namer-model", got.TitleModel)
		})

		t.Run("write_through_survives_reread", func(t *testing.T) {
			h := newSessionAPI(t)
			code, _ := put[struct {
				TitleModel string `json:"titleModel"`
			}](h, "/api/settings", map[string]string{"titleModel": " namer-model "})
			require.Equal(t, http.StatusOK, code)

			// the write lands in swarm's own database, not just the reply
			code, got := get[struct {
				TitleModel string `json:"titleModel"`
			}](h, "/api/settings")
			require.Equal(t, http.StatusOK, code)
			assert.Equal(t, "namer-model", got.TitleModel)
		})

		t.Run("empty_model_clears", func(t *testing.T) {
			h := newSessionAPI(t)
			code, _ := put[struct {
				TitleModel string `json:"titleModel"`
			}](h, "/api/settings", map[string]string{"titleModel": "namer-model"})
			require.Equal(t, http.StatusOK, code)

			// an empty model clears the setting back to the per-session default
			code, got := put[struct {
				TitleModel string `json:"titleModel"`
			}](h, "/api/settings", map[string]string{"titleModel": ""})
			require.Equal(t, http.StatusOK, code)
			assert.Empty(t, got.TitleModel)
		})

		t.Run("missing_field_bad_request", func(t *testing.T) {
			h := newSessionAPI(t)

			// a body without the field is a bad request, not a silent clear
			code, _ := put[struct{}](h, "/api/settings", map[string]string{})
			assert.Equal(t, http.StatusBadRequest, code)
		})
	})

	t.Run("model_options_endpoint", func(t *testing.T) {
		h := newSessionAPI(t)
		f := h.addSession("01MODELOPTS000000000", fleettest.Options{})
		f.Result(ctl.MethodModelsGet, ctl.ModelsData{
			Active: "anthropic/claude-sonnet",
			Models: []ctl.ModelState{
				{Key: "anthropic/claude-sonnet", Short: "sonnet", Window: 200000},
				{Key: "anthropic/claude-haiku", Short: "haiku", Window: 100000},
			},
		})

		code, got := get[[]ctl.ModelState](h, "/api/models/options")
		require.Equal(t, http.StatusOK, code)
		require.Len(t, got, 2)
		// the union comes back sorted by key, whatever order sessions reported
		assert.Equal(t, "anthropic/claude-haiku", got[0].Key)
		assert.Equal(t, "anthropic/claude-sonnet", got[1].Key)
		assert.Equal(t, "haiku", got[0].Short)
	})

	t.Run("tool_options_endpoint", func(t *testing.T) {
		h := newSessionAPI(t)
		// snapshots seed each actor's view at attach, so they precede serving, the
		// two sessions share one tool name, which the union must collapse
		a := h.newStub("01TOOLSOPTS0000000000", fleettest.Options{})
		a.SetSnapshot(ctl.State{
			Tools: []ctl.ToolState{
				{Name: "web_search", Source: "built-in"},
				{Name: "repo_search", Source: "mcp:repo"},
			},
		})
		h.serve(a)
		b := h.newStub("01TOOLSOPTS0000000001", fleettest.Options{})
		b.SetSnapshot(ctl.State{
			Tools: []ctl.ToolState{
				{Name: "bash", Source: "built-in"},
				{Name: "repo_search", Source: "mcp:repo"}, // duplicates a's row
			},
		})
		h.serve(b)

		code, got := get[[]ctl.ToolState](h, "/api/tools/options")
		require.Equal(t, http.StatusOK, code)
		require.Len(t, got, 3)
		// the union comes back sorted by name and carries each row's source
		assert.Equal(t, "bash", got[0].Name)
		assert.Equal(t, "repo_search", got[1].Name)
		assert.Equal(t, "mcp:repo", got[1].Source)
		assert.Equal(t, "web_search", got[2].Name)
	})

	t.Run("model_lists_empty_fleet_body", func(t *testing.T) {
		h := newSessionAPI(t)

		for _, path := range []string{"/api/models", "/api/models/options", "/api/tools/options"} {
			resp := call(t, h.client, h.server.URL, http.MethodGet, path, nil)
			require.Equal(t, http.StatusOK, resp.StatusCode)
			raw, err := io.ReadAll(resp.Body)
			require.NoError(t, err)
			// raw text: a typed decode would accept null silently
			assert.Equal(t, "[]", strings.TrimSpace(string(raw)))
		}
	})
}
