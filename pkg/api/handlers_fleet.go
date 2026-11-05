package api

import (
	"net/http"
	"strconv"

	"github.com/jentfoo/ajent/pkg/ctl"
)

// defaultPageLimit matches the fleet package's init tail sizing.
const defaultPageLimit = 200

// handleSessionList serves the fleet listing: one row per tracked instance.
func (s *apiServer) handleSessionList(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.fleet.Sessions())
}

// handleSessionEntries pages through one session's committed entries with the
// full payload every time: base64 image bodies load lazily here.
func (s *apiServer) handleSessionEntries(w http.ResponseWriter, r *http.Request) {
	limit, ok := parseLimit(w, r)
	if !ok {
		return
	}
	entries, cursor, err := s.fleet.Entries(r.Context(), r.PathValue("id"), r.URL.Query().Get("before"), limit)
	if err != nil {
		writeCommandFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entriesPage{Entries: entries, Cursor: cursor})
}

// entriesPage is one page of committed history plus the cursor to continue.
type entriesPage struct {
	Entries []ctl.Entry `json:"entries"`
	Cursor  string      `json:"cursor,omitempty"`
}

// parseLimit reads the ?limit paging parameter, answering a 400 and false
// when it is not a positive integer.
func parseLimit(w http.ResponseWriter, r *http.Request) (int, bool) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return defaultPageLimit, true
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed < 1 {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "limit must be a positive integer")
		return 0, false
	}
	return parsed, true
}

// handleTakeControl issues one force claim for the session's control seat,
// the explicit action behind a seat.lost banner. It never runs automatically.
func (s *apiServer) handleTakeControl(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	err := s.fleet.TakeControl(r.Context(), id)
	if err != nil {
		writeCommandFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
