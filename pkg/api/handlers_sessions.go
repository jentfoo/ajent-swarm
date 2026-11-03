package api

import (
	"cmp"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"

	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// maxPendingID bounds a client-supplied correlation: it rides queue rows and
// committed entries, so a giant one would poison both.
const maxPendingID = 128

// submitRequest is the POST /submit body. PendingID names the caller's
// optimistic row; omit it and swarm mints one to echo back.
type submitRequest struct {
	Line      string `json:"line"`
	PendingID string `json:"pendingId,omitempty"`
}

type submitReply struct {
	PendingID string `json:"pendingId"`
}

// interruptReply names what an interrupt stopped, empty when nothing ran.
type interruptReply struct {
	Stopped string `json:"stopped,omitempty"`
}

// modeRequest steps the permission mode: Back cycles backwards, a non-empty
// Mode jumps straight to that name and wins over Back. The body is optional.
type modeRequest struct {
	Back bool   `json:"back,omitempty"`
	Mode string `json:"mode,omitempty"`
}

type rewindRequest struct {
	Head string `json:"head"`
}

type rewindReply struct {
	Head string `json:"head"`
}

// resolveRequest answers one dialog. Exactly one of Index, Indexes, Text and
// Cancel may ride; Chat only marks a text answer.
type resolveRequest struct {
	DialogID uint64  `json:"dialogId"`
	Index    *int    `json:"index,omitempty"`
	Indexes  *[]int  `json:"indexes,omitempty"`
	Text     *string `json:"text,omitempty"`
	Chat     bool    `json:"chat,omitempty"`
	Cancel   bool    `json:"cancel,omitempty"`
}

// resolveReply marks the settled case: a first answer had already won.
type resolveReply struct {
	Settled bool `json:"settled"`
}

// writeCommandFailure maps one fleet command error onto its response and
// reports whether it consumed the error: unknown sessions are 404 before any
// dialing, wire refusals keep their codes.
func writeCommandFailure(w http.ResponseWriter, err error) bool {
	if errors.Is(err, fleet.ErrUnknownSession) {
		writeError(w, http.StatusNotFound, "session_not_found", "")
		return true
	}
	return writeControlError(w, err)
}

// newPendingID mints the correlation a submit echoes back to its caller.
func newPendingID() string {
	var b [8]byte
	rand.Read(b[:]) // crypto/rand never fails; nothing sensible to answer anyway
	return hex.EncodeToString(b[:])
}

// handleSessionSubmit routes one prompt line exactly as typed in the session's
// editor, answering 202 with the pendingId echoed so optimistic rows resolve.
func (s *apiServer) handleSessionSubmit(w http.ResponseWriter, r *http.Request) {
	var req submitRequest
	if !readRequest(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Line) == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "line must not be empty")
		return
	}
	if len(req.PendingID) > maxPendingID {
		writeError(w, http.StatusBadRequest, "invalid_request", "pendingId is too long")
		return
	}
	pendingID := cmp.Or(req.PendingID, newPendingID())
	err := s.fleet.Submit(r.Context(), r.PathValue("id"), ctl.SubmitParams{Line: req.Line, PendingID: pendingID})
	switch {
	case err == nil:
		writeJSON(w, http.StatusAccepted, submitReply{PendingID: pendingID})
	case writeCommandFailure(w, err):
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "")
	}
}

// handleSessionInterrupt runs the session's Esc body remotely.
func (s *apiServer) handleSessionInterrupt(w http.ResponseWriter, r *http.Request) {
	stopped, err := s.fleet.Interrupt(r.Context(), r.PathValue("id"))
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, interruptReply{Stopped: stopped})
	case writeCommandFailure(w, err):
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "")
	}
}

// handleSessionMode steps or sets the permission mode and answers with the
// mode now in effect. A non-empty body mode jumps straight there, matching the
// dropdown; an empty body cycles like Shift+Tab.
func (s *apiServer) handleSessionMode(w http.ResponseWriter, r *http.Request) {
	var req modeRequest
	if !readOptionalRequest(w, r, &req) {
		return
	}
	id := r.PathValue("id")
	var mode string
	var err error
	if req.Mode != "" {
		mode, err = s.fleet.ModeSet(r.Context(), id, req.Mode)
	} else {
		mode, err = s.fleet.ModeCycle(r.Context(), id, req.Back)
	}
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, ctl.ModeResult{Mode: mode})
	case writeCommandFailure(w, err):
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "")
	}
}

// handleSessionRewind forks onto an earlier transcript entry. Candidate rules
// stay with the UI and upstream; a refused head keeps its coded refusal.
func (s *apiServer) handleSessionRewind(w http.ResponseWriter, r *http.Request) {
	var req rewindRequest
	if !readRequest(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Head) == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "head must not be empty")
		return
	}
	head, err := s.fleet.Rewind(r.Context(), r.PathValue("id"), req.Head)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, rewindReply{Head: head})
	case writeCommandFailure(w, err):
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "")
	}
}

// handleSessionResolve answers one open dialog, exactly one shape at a time.
// A dialog that already resolved answers 200 settled:true, first answer wins.
func (s *apiServer) handleSessionResolve(w http.ResponseWriter, r *http.Request) {
	var req resolveRequest
	if !readRequest(w, r, &req) {
		return
	}
	params, ok := req.params()
	if !ok {
		writeError(w, http.StatusBadRequest,
			"invalid_request", "exactly one of index, indexes, text or cancel is required")
		return
	}
	err := s.fleet.Resolve(r.Context(), r.PathValue("id"), params)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, resolveReply{Settled: false})
	case settledDialog(err):
		writeJSON(w, http.StatusOK, resolveReply{Settled: true})
	case writeCommandFailure(w, err):
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "")
	}
}

// params validates the answer shape into wire params.
func (req resolveRequest) params() (ctl.ResolveParams, bool) {
	p := ctl.ResolveParams{ID: req.DialogID, Chat: req.Chat}
	shapes := 0
	if req.Index != nil {
		p.Index = req.Index
		shapes++
	}
	if req.Indexes != nil {
		p.Indexes = req.Indexes
		shapes++
	}
	if req.Text != nil {
		p.Text = req.Text
		shapes++
	}
	if req.Cancel {
		p.Cancel = true
		shapes++
	}
	if shapes != 1 || (req.Chat && req.Text == nil) {
		return ctl.ResolveParams{}, false
	}
	return p, true
}

// settledDialog reports whether the refusal says the dialog already resolved.
func settledDialog(err error) bool {
	var ce *ctl.Error
	return errors.As(err, &ce) && ce.Code == ctl.CodeSettled
}

// handleSessionRecall pops the newest queued prompt by row id for
// edit-and-resubmit; no single-row delete verb exists upstream. An empty
// result means nothing was queued.
func (s *apiServer) handleSessionRecall(w http.ResponseWriter, r *http.Request) {
	row, err := s.fleet.Recall(r.Context(), r.PathValue("id"))
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, row)
	case writeCommandFailure(w, err):
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "")
	}
}

// handleSessionCandidates serves the rewind picker feed derived from the
// session's transcript tree, current head marked from its live snapshot.
func (s *apiServer) handleSessionCandidates(w http.ResponseWriter, r *http.Request) {
	res, err := s.fleet.Candidates(r.Context(), r.PathValue("id"))
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, res)
	case writeCommandFailure(w, err):
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "")
	}
}

// handleSessionSnapshot serves the actor's reconciled state for polling
// clients, the same shape a stream init carries.
func (s *apiServer) handleSessionSnapshot(w http.ResponseWriter, r *http.Request) {
	state, err := s.fleet.Snapshot(r.Context(), r.PathValue("id"))
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, state)
	case writeCommandFailure(w, err):
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "")
	}
}

// filesReply answers one @-completion query for the composer.
type filesReply struct {
	Items []fleet.FileSuggestion `json:"items"`
}

// handleSessionFiles completes @ file paths against the session's working
// directory; an unreadable target answers empty rather than failing.
func (s *apiServer) handleSessionFiles(w http.ResponseWriter, r *http.Request) {
	items, err := s.fleet.Files(r.Context(), r.PathValue("id"), r.URL.Query().Get("query"))
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, filesReply{Items: items})
	case writeCommandFailure(w, err):
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "")
	}
}

// handleAttention serves the per-live-session digest behind the inbox rail
// and notification badges; no session stream is subscribed anywhere.
func (s *apiServer) handleAttention(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.fleet.Attention())
}

// handleModels serves the models listing: one row per live session whose
// current model comes from its snapshot. Switching goes through POST /model
// against the same registry models.get lists.
func (s *apiServer) handleModels(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.fleet.ModelRows(r.Context()))
}
