package api

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent-swarm/pkg/store"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// settingsStore adapts the SQLite store to fleet's SettingsStore interface
// for the harness, mirroring pkg/app's production adapter.
type settingsStore struct{ st *store.Store }

func (a settingsStore) Setting(ctx context.Context, key string) (string, error) {
	return a.st.Setting(ctx, key)
}

func (a settingsStore) SetSetting(ctx context.Context, key, value string) error {
	return a.st.SetSetting(ctx, key, value)
}

// The swarm-level settings endpoints plus the model-options union feed the
// global settings surfaces on desktop and mobile.
func TestGlobalSettingsEndpoints(t *testing.T) {
	h := newSessionAPI(t)

	code, got := get[struct {
		TitleModel string `json:"titleModel"`
	}](h, "/api/settings")
	require.Equal(t, http.StatusOK, code)
	assert.Empty(t, got.TitleModel) // the default ships unset

	code, got = put[struct {
		TitleModel string `json:"titleModel"`
	}](h, "/api/settings", map[string]string{"titleModel": " namer-model "})
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, "namer-model", got.TitleModel)

	// the write-through survives a read and lands in swarm's own database
	code, got = get[struct {
		TitleModel string `json:"titleModel"`
	}](h, "/api/settings")
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, "namer-model", got.TitleModel)

	// an empty model clears the setting back to the per-session default
	code, got = put[struct {
		TitleModel string `json:"titleModel"`
	}](h, "/api/settings", map[string]string{"titleModel": ""})
	require.Equal(t, http.StatusOK, code)
	assert.Empty(t, got.TitleModel)

	// a body without the field is a bad request, not a silent clear
	code, _ = put[struct{}](h, "/api/settings", map[string]string{})
	assert.Equal(t, http.StatusBadRequest, code)
}

func TestModelOptionsEndpoint(t *testing.T) {
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
}

func TestToolOptionsEndpoint(t *testing.T) {
	h := newSessionAPI(t)
	// snapshots seed each actor's view at attach, so they precede serving; the
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
}

func TestModelListsEmptyFleetBody(t *testing.T) {
	h := newSessionAPI(t)

	for _, path := range []string{"/api/models", "/api/models/options", "/api/tools/options"} {
		resp := call(t, h.client, h.server.URL, http.MethodGet, path, nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		raw, err := io.ReadAll(resp.Body)
		require.NoError(t, err)
		// raw text: a typed decode would accept null silently
		assert.Equal(t, "[]", strings.TrimSpace(string(raw)))
	}
}
