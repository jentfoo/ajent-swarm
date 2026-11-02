package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// defaultPageLimit matches the fleet package's init tail sizing.
const defaultPageLimit = 200

// handleSessionList serves the fleet listing: one row per tracked instance.
func (s *apiServer) handleSessionList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.fleet.Sessions())
}

// handleSessionEntries pages through one session's committed entries with the
// full payload every time: base64 image bodies load lazily here.
func (s *apiServer) handleSessionEntries(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	limit := defaultPageLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			writeError(w, http.StatusBadRequest, "invalid_request", "limit must be a positive integer")
			return
		}
		limit = parsed
	}
	entries, cursor, err := s.fleet.Entries(r.Context(), id, r.URL.Query().Get("before"), limit)
	switch {
	case errors.Is(err, fleet.ErrUnknownSession):
		writeError(w, http.StatusNotFound, "session_not_found", "")
	case err != nil:
		writeError(w, http.StatusInternalServerError, "internal_error", "reading entries failed")
	default:
		writeJSON(w, http.StatusOK, entriesPage{Entries: entries, Cursor: cursor})
	}
}

// entriesPage is one page of committed history plus the cursor to continue.
type entriesPage struct {
	Entries []ctl.Entry `json:"entries"`
	Cursor  string      `json:"cursor,omitempty"`
}

// handleTakeControl issues one force claim for the session's control seat,
// the explicit action behind a seat.lost banner. It never runs automatically.
func (s *apiServer) handleTakeControl(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	err := s.fleet.TakeControl(r.Context(), id)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, fleet.ErrUnknownSession):
		writeError(w, http.StatusNotFound, "session_not_found", "")
	case writeControlError(w, err):
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "")
	}
}
