package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// Control-method endpoints: upstream control-surface commands (models,
// tools, settings) proxied onto live sessions, plus swarm-side display titles.

// modelSetRequest is the POST /model body; a missing model is bad-request.
type modelSetRequest struct {
	Model string `json:"model"`
}

// toolsRequest reshapes the enabled set; names left out keep their state past
// the first dispatched prompt (widen-only upstream rule).
type toolsRequest struct {
	Names []string `json:"names"`
}

// settingSetRequest applies one row; value carries the JSON in the row's own
// shape and persist optionally copies it to user or project.
type settingSetRequest struct {
	Key     string          `json:"key"`
	Value   json.RawMessage `json:"value,omitempty"`
	Persist string          `json:"persist,omitempty"`
}

// titleRequest renames a session in swarm storage only; empty clears.
type titleRequest struct {
	Title string `json:"title"`
}

// handleSessionModels serves the model registry listing.
func (s *apiServer) handleSessionModels(w http.ResponseWriter, r *http.Request) {
	data, err := s.fleet.Models(r.Context(), r.PathValue("id"))
	if err != nil {
		writeCommandFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, data)
}

// handleSessionModelSet switches the session-only model and answers what it
// resolved to; a running turn queues the switch at its boundary.
func (s *apiServer) handleSessionModelSet(w http.ResponseWriter, r *http.Request) {
	var req modelSetRequest
	if !readRequest(w, r, &req) {
		return
	}
	if req.Model == "" {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "model must not be empty")
		return
	}
	key, err := s.fleet.ModelSet(r.Context(), r.PathValue("id"), req.Model)
	if err != nil {
		writeCommandFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, modelSetReply{Model: key})
}

// modelSetReply names the canonical key the switch resolved to.
type modelSetReply struct {
	Model string `json:"model"`
}

// handleSessionTools reshapes the enabled tool set and answers the rows after
// it, the same full replacement the tools event carries.
func (s *apiServer) handleSessionTools(w http.ResponseWriter, r *http.Request) {
	var req toolsRequest
	if !readOptionalRequest(w, r, &req) {
		return
	}
	res, err := s.fleet.ToolsSet(r.Context(), r.PathValue("id"), req.Names)
	if err != nil {
		writeCommandFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// handleSessionSettings serves the /settings rows in menu order.
func (s *apiServer) handleSessionSettings(w http.ResponseWriter, r *http.Request) {
	data, err := s.fleet.Settings(r.Context(), r.PathValue("id"))
	if err != nil {
		writeCommandFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, data)
}

// handleSessionSettingSet applies one setting as a session override; the reply
// is the row after the change so menus re-render from it.
func (s *apiServer) handleSessionSettingSet(w http.ResponseWriter, r *http.Request) {
	var req settingSetRequest
	if !readRequest(w, r, &req) {
		return
	}
	if req.Key == "" {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "key must not be empty")
		return
	}
	res, err := s.fleet.SettingSet(r.Context(), r.PathValue("id"), ctl.SettingsSetParams{
		Key:     req.Key,
		Value:   req.Value,
		Persist: req.Persist,
	})
	if err != nil {
		writeCommandFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// handleSessionTitle writes one swarm-side display title. Renames never touch
// ajent's own session names, so resume targets stay untouched.
func (s *apiServer) handleSessionTitle(w http.ResponseWriter, r *http.Request) {
	var req titleRequest
	if !readRequest(w, r, &req) {
		return
	}
	err := s.fleet.SetTitle(r.Context(), r.PathValue("id"), req.Title)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, fleet.ErrUnknownSession):
		// SetTitle only returns that sentinel for an empty id: renames target
		// swarm storage, not tracked sessions, so this is a bad request
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "sessionId must not be empty")
	case errors.Is(err, fleet.ErrNoTitleStore):
		writeError(w, http.StatusInternalServerError, codeInternalError, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, codeInternalError, "writing the title failed")
	}
}
