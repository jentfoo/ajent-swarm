package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/jentfoo/ajent-swarm/pkg/fleet"
)

// settingsReply is the swarm-level settings document: one flat view today,
// growing per feature without a version bump.
type settingsReply struct {
	TitleModel string `json:"titleModel"`
}

// settingsRequest carries one PUT body; fields omitted stay untouched.
type settingsRequest struct {
	TitleModel *string `json:"titleModel"`
}

// handleSettingsGet serves the swarm-level settings.
func (s *apiServer) handleSettingsGet(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, settingsReply{TitleModel: s.fleet.TitleModel()})
}

// handleSettingsSet writes through one swarm-level setting. An empty titling
// model clears it, so sessions name with their own model again.
func (s *apiServer) handleSettingsSet(w http.ResponseWriter, r *http.Request) {
	var req settingsRequest
	if !readRequest(w, r, &req) {
		return
	}
	if req.TitleModel == nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "titleModel is required")
		return
	}
	model := strings.TrimSpace(*req.TitleModel)
	if len([]rune(model)) > 200 {
		writeError(w, http.StatusBadRequest, "invalid_request", "titleModel is too long")
		return
	}
	switch err := s.fleet.SetTitleModel(r.Context(), model); {
	case err == nil:
		writeJSON(w, http.StatusOK, settingsReply{TitleModel: s.fleet.TitleModel()})
	case errors.Is(err, fleet.ErrNoSettingStore):
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "writing the setting failed")
	}
}

// handleModelOptions serves the union of every live session's model registry:
// the choices swarm-level model pickers offer.
func (s *apiServer) handleModelOptions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.fleet.ModelOptions(r.Context()))
}
