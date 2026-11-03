package api

import (
	"errors"
	"net/http"

	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/session"
)

// handleLaunch spawns one headless ajent session as a child of the service
// and answers once its control socket appeared.
func (s *apiServer) handleLaunch(w http.ResponseWriter, r *http.Request) {
	var req fleet.LaunchRequest
	if !readRequest(w, r, &req) {
		return
	}
	res, err := s.fleet.Launch(r.Context(), req)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, res)
	case errors.Is(err, fleet.ErrInvalidLaunch):
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
	case errors.Is(err, fleet.ErrUnknownSaved):
		// an unrecorded resume target: the transcript never landed or ajent
		// dropped it on exit, so no child is spawned to rediscover that
		writeError(w, http.StatusNotFound, codeSessionNotFound, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "launch_failed", err.Error())
	}
}

// handleStop ends a session through the stop path: /exit first, then signals
// for children swarm spawned.
func (s *apiServer) handleStop(w http.ResponseWriter, r *http.Request) {
	err := s.fleet.StopSession(r.Context(), r.PathValue("id"))
	if err == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var ce *ctl.Error
	if errors.Is(err, fleet.ErrUnknownSession) || errors.As(err, &ce) {
		// mapped failures keep their codes; anything else names the stop itself
		writeCommandFailure(w, err)
		return
	}
	writeError(w, http.StatusInternalServerError, "stop_failed", err.Error())
}

// handleSavedSessions serves the resume picker listing: every saved session
// under the ajent home, most recently used first.
func (s *apiServer) handleSavedSessions(w http.ResponseWriter, _ *http.Request) {
	rows, err := s.fleet.SavedSessions()
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternalError, "reading saved sessions failed")
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// handleSavedEntries pages one recorded transcript for offline browsing,
// branching by a tip derived at read time.
func (s *apiServer) handleSavedEntries(w http.ResponseWriter, r *http.Request) {
	limit, ok := parseLimit(w, r)
	if !ok {
		return
	}
	page, err := s.fleet.SavedEntries(r.PathValue("id"), r.URL.Query().Get("before"), limit)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, page)
	case errors.Is(err, fleet.ErrUnknownSaved):
		writeError(w, http.StatusNotFound, codeSessionNotFound, "")
	case errors.Is(err, fleet.ErrAmbiguousSaved):
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
	case errors.Is(err, session.ErrNewerFormat):
		writeError(w, http.StatusConflict, "unsupported_format", err.Error())
	default:
		writeError(w, http.StatusInternalServerError, codeInternalError, "reading transcript failed")
	}
}
