package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/paths"
	"github.com/jentfoo/ajent/pkg/session"
)

// chainBody is the create/edit body shared by the chain endpoint tests.
func chainBody(childID, final, child string) map[string]any {
	return map[string]any{"childId": childID, "finalPrompt": final, "childPrompt": child}
}

// writeSavedParent records one transcript under the isolated home's sessions
// root, so the registry still knows a session whose discovery record is gone.
func writeSavedParent(t *testing.T, sessionID string) {
	t.Helper()
	dir := filepath.Join(os.Getenv(paths.EnvHome), "sessions", "proj")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	hdr, err := json.Marshal(map[string]any{
		"version": 1, "cwd": os.Getenv(paths.EnvHome), "workspace": "/repo", "name": "",
	})
	require.NoError(t, err)
	line, err := json.Marshal(session.Entry{ID: sessionID, Type: session.TypeSession,
		TS: time.Now().UnixMilli(), Data: hdr})
	require.NoError(t, err)
	path := filepath.Join(dir, sessionID+".jsonl")
	require.NoError(t, os.WriteFile(path, append(line, '\n'), 0o600))
}

func TestChainEndpoints(t *testing.T) {
	t.Run("create_edit_and_cancel", func(t *testing.T) {
		h := newSessionAPI(t)
		parent := h.addSession("01PARENTSESSION00000A", fleettest.Options{})
		parent.Broadcast(ctl.EventTurnStart, nil) // hold the chain in waiting
		waitRunning(h, parent.SessionID(), true)
		child := h.addSession("01CHILDSESSION00000B", fleettest.Options{})

		code, created := post[fleet.Chain](h,
			"/api/sessions/"+parent.SessionID()+"/chain",
			chainBody(child.SessionID(), "wrap up", "continue"))
		require.Equal(t, http.StatusCreated, code)
		assert.True(t, strings.HasPrefix(created.ID, "chn_"))
		assert.Equal(t, fleet.ChainWaiting, created.State)
		assert.Equal(t, parent.SessionID(), created.ParentID)
		assert.Equal(t, child.SessionID(), created.ChildID)
		assert.NotEmpty(t, created.PendingID) // minted server-side

		code, read := callJSON[fleet.Chain](t, h.client, h.server.URL,
			http.MethodGet, "/api/chains/"+created.ID, nil)
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, created.ID, read.ID)
		code, _ = callJSON[struct{}](t, h.client, h.server.URL,
			http.MethodGet, "/api/chains/chn_deadbeef", nil)
		require.Equal(t, http.StatusNotFound, code)

		code, edited := callJSON[fleet.Chain](t, h.client, h.server.URL,
			http.MethodPatch, "/api/chains/"+created.ID, chainBody("", "", "edited"))
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, "edited", edited.ChildPrompt)

		code, _ = callJSON[struct{}](t, h.client, h.server.URL,
			http.MethodDelete, "/api/chains/"+created.ID, nil)
		require.Equal(t, http.StatusNoContent, code)

		// canceled chains answer a second cancel clean, unknown ids 404
		code, _ = callJSON[struct{}](t, h.client, h.server.URL,
			http.MethodDelete, "/api/chains/"+created.ID, nil)
		require.Equal(t, http.StatusNoContent, code)
		code, body := callJSON[errorBody](t, h.client, h.server.URL,
			http.MethodDelete, "/api/chains/chn_deadbeef", nil)
		requireCoded(h, http.StatusNotFound, codeChainNotFound, code, body)
	})

	t.Run("coded_refusals", func(t *testing.T) {
		h := newSessionAPI(t)
		parent := h.addSession("01PARENTSESSION00000A", fleettest.Options{})
		parent.Broadcast(ctl.EventTurnStart, nil)
		waitRunning(h, parent.SessionID(), true)
		child := h.addSession("01CHILDSESSION00000B", fleettest.Options{})

		code, body := callJSON[errorBody](t, h.client, h.server.URL, http.MethodPost,
			"/api/sessions/"+parent.SessionID()+"/chain", chainBody("01MISSING000000000", "", "go"))
		requireCoded(h, http.StatusNotFound, codeSessionNotFound, code, body)

		code, body = callJSON[errorBody](t, h.client, h.server.URL, http.MethodPost,
			"/api/sessions/"+parent.SessionID()+"/chain", chainBody(child.SessionID(), "", ""))
		requireCoded(h, http.StatusBadRequest, codeChainInvalid, code, body)

		createCode, created := post[fleet.Chain](h,
			"/api/sessions/"+parent.SessionID()+"/chain",
			chainBody(child.SessionID(), "", "continue"))
		require.Equal(t, http.StatusCreated, createCode)
		third := h.addSession("01THIRDSESSION000000C", fleettest.Options{})
		code, body = callJSON[errorBody](t, h.client, h.server.URL, http.MethodPost,
			"/api/sessions/"+third.SessionID()+"/chain", chainBody(child.SessionID(), "", "again"))
		requireCoded(h, http.StatusConflict, codeChainConflict, code, body)

		// chaining back onto the parent closes a cycle onto itself
		code, body = callJSON[errorBody](t, h.client, h.server.URL, http.MethodPost,
			"/api/sessions/"+child.SessionID()+"/chain", chainBody(parent.SessionID(), "", "loop"))
		requireCoded(h, http.StatusConflict, codeChainConflict, code, body)

		// a canceled chain frees the child and answers a late edit 409
		code, _ = callJSON[struct{}](t, h.client, h.server.URL,
			http.MethodDelete, "/api/chains/"+created.ID, nil)
		require.Equal(t, http.StatusNoContent, code)
		code, body = callJSON[errorBody](t, h.client, h.server.URL, http.MethodPatch,
			"/api/chains/"+created.ID, chainBody("", "", "late"))
		requireCoded(h, http.StatusConflict, codeChainConflict, code, body)
	})

	t.Run("list_snapshots_records", func(t *testing.T) {
		h := newSessionAPI(t)
		parent := h.addSession("01PARENTSESSION00000A", fleettest.Options{})
		parent.Broadcast(ctl.EventTurnStart, nil)
		waitRunning(h, parent.SessionID(), true)
		child := h.addSession("01CHILDSESSION00000B", fleettest.Options{})

		code, rows := callJSON[[]fleet.Chain](t, h.client, h.server.URL,
			http.MethodGet, "/api/chains", nil)
		require.Equal(t, http.StatusOK, code)
		assert.Empty(t, rows) // empty lists encode [], never null

		createCode, _ := post[fleet.Chain](h, "/api/sessions/"+parent.SessionID()+"/chain",
			chainBody(child.SessionID(), "", "continue"))
		require.Equal(t, http.StatusCreated, createCode)
		code, rows = callJSON[[]fleet.Chain](t, h.client, h.server.URL,
			http.MethodGet, "/api/chains", nil)
		require.Equal(t, http.StatusOK, code)
		require.Len(t, rows, 1)
		assert.Equal(t, child.SessionID(), rows[0].ChildID)
	})

	t.Run("parent_gone_codes_its_refusal", func(t *testing.T) {
		h := newSessionAPI(t)
		child := h.addSession("01CHILDSESSION00000B", fleettest.Options{})
		// a recorded parent whose discovery record is gone stays known to the
		// transcript, but nothing can run its final prompt anymore
		parent := h.addSession("01PARENTSESSION00000A", fleettest.Options{})
		writeSavedParent(t, parent.SessionID())
		parent.RemoveRegistry()
		require.Eventually(t, func() bool {
			code, _ := post[struct{}](h, "/api/sessions/"+parent.SessionID()+"/submit",
				map[string]any{"line": "ping"})
			return code == http.StatusNotFound
		}, 2*time.Second, 5*time.Millisecond)

		code, body := callJSON[errorBody](t, h.client, h.server.URL, http.MethodPost,
			"/api/sessions/"+parent.SessionID()+"/chain",
			chainBody(child.SessionID(), "wrap up", "continue"))
		requireCoded(h, http.StatusConflict, codeChainParentGone, code, body)
	})

	t.Run("strict_bodies", func(t *testing.T) {
		h := newSessionAPI(t)
		parent := h.addSession("01PARENTSESSION00000A", fleettest.Options{})

		code, body := callJSON[errorBody](t, h.client, h.server.URL, http.MethodPost,
			"/api/sessions/"+parent.SessionID()+"/chain",
			map[string]any{"childId": "01X", "childPrompt": "go", "extra": 1})
		requireCoded(h, http.StatusBadRequest, codeInvalidRequest, code, body)
	})
}

// waitRunning blocks until the fleet reports the session's busy flag.
func waitRunning(h *sessionHarness, sessionID string, running bool) {
	h.t.Helper()
	require.Eventually(h.t, func() bool {
		for _, st := range h.mgr.Sessions() {
			if st.SessionID == sessionID {
				return st.Running == running
			}
		}
		return false
	}, 2*time.Second, 5*time.Millisecond)
}
