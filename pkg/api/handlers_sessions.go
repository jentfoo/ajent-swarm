package api

import (
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

// writeCommandFailure maps one fleet command error onto its response:
// unknown sessions are 404 before any dialing, wire refusals keep their
// codes, anything else answers a bare 500.
func writeCommandFailure(w http.ResponseWriter, err error) {
	if errors.Is(err, fleet.ErrUnknownSession) {
		writeError(w, http.StatusNotFound, codeSessionNotFound, "")
		return
	}
	var ce *ctl.Error
	if errors.As(err, &ce) {
		writeError(w, statusForControl(ce), ce.Code, ce.Message)
		return
	}
	writeError(w, http.StatusInternalServerError, codeInternalError, "")
}

// handleSessionSubmit routes one prompt line exactly as typed in the session's
// editor, answering 202 with the pendingId echoed so optimistic rows resolve.
func (s *apiServer) handleSessionSubmit(w http.ResponseWriter, r *http.Request) {
	var req submitRequest
	if !readRequest(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Line) == "" {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "line must not be empty")
		return
	}
	if len(req.PendingID) > maxPendingID {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "pendingId is too long")
		return
	}
	pendingID := req.PendingID
	if pendingID == "" {
		var b [8]byte
		rand.Read(b[:]) // crypto/rand never fails; nothing sensible to answer anyway
		pendingID = hex.EncodeToString(b[:])
	}
	err := s.fleet.SubmitTracked(r.Context(), r.PathValue("id"),
		ctl.SubmitParams{Line: req.Line, PendingID: pendingID})
	if err != nil {
		writeCommandFailure(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, submitReply{PendingID: pendingID})
}

// handleSessionInterrupt runs the session's Esc body remotely.
func (s *apiServer) handleSessionInterrupt(w http.ResponseWriter, r *http.Request) {
	stopped, err := s.fleet.Interrupt(r.Context(), r.PathValue("id"))
	if err != nil {
		writeCommandFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, interruptReply{Stopped: stopped})
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
	var (
		mode string
		err  error
	)
	if req.Mode != "" {
		mode, err = s.fleet.ModeSet(r.Context(), id, req.Mode)
	} else {
		mode, err = s.fleet.ModeCycle(r.Context(), id, req.Back)
	}
	if err != nil {
		writeCommandFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ctl.ModeResult{Mode: mode})
}

// handleSessionRewind forks onto an earlier transcript entry. Candidate rules
// stay with the UI and upstream; a refused head keeps its coded refusal.
func (s *apiServer) handleSessionRewind(w http.ResponseWriter, r *http.Request) {
	var req rewindRequest
	if !readRequest(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Head) == "" {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "head must not be empty")
		return
	}
	head, err := s.fleet.Rewind(r.Context(), r.PathValue("id"), req.Head)
	if err != nil {
		writeCommandFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rewindReply{Head: head})
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
			codeInvalidRequest, "exactly one of index, indexes, text or cancel is required")
		return
	}
	err := s.fleet.Resolve(r.Context(), r.PathValue("id"), params)
	var ce *ctl.Error
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, resolveReply{Settled: false})
	case errors.As(err, &ce) && ce.Code == ctl.CodeSettled: // already answered
		writeJSON(w, http.StatusOK, resolveReply{Settled: true})
	default:
		writeCommandFailure(w, err)
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

// handleSessionRecall pops the newest queued prompt by row id for
// edit-and-resubmit; no single-row delete verb exists upstream. An empty
// result means nothing was queued.
func (s *apiServer) handleSessionRecall(w http.ResponseWriter, r *http.Request) {
	row, err := s.fleet.Recall(r.Context(), r.PathValue("id"))
	if err != nil {
		writeCommandFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, row)
}

// agentsListReply answers one agents query: every sub-agent job in
// job-number order, finished ones included.
type agentsListReply struct {
	Jobs []ctl.AgentJob `json:"jobs"`
}

// handleSessionAgents lists the session's sub-agent jobs, the structured read
// the tally badge and per-job stop controls pull while any job is live. A
// session with no sub-agent wiring keeps its coded unavailable refusal.
func (s *apiServer) handleSessionAgents(w http.ResponseWriter, r *http.Request) {
	res, err := s.fleet.AgentsList(r.Context(), r.PathValue("id"))
	if err != nil {
		writeCommandFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, agentsListReply{Jobs: orEmptySlice(res.Jobs)})
}

// agentsStopRequest names one job by id, or every in-flight job with all.
// Exactly-one is upstream's rule; the route forwards the shape unmunged.
type agentsStopRequest struct {
	ID  string `json:"id,omitempty"`
	All bool   `json:"all,omitempty"`
}

// handleSessionAgentsStop cancels one sub-agent job or every in-flight one,
// riding swarm's seat policy like every other mutation.
func (s *apiServer) handleSessionAgentsStop(w http.ResponseWriter, r *http.Request) {
	var req agentsStopRequest
	if !readRequest(w, r, &req) {
		return
	}
	res, err := s.fleet.AgentsStop(r.Context(), r.PathValue("id"),
		ctl.AgentsStopParams{ID: req.ID, All: req.All})
	if err != nil {
		writeCommandFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// recallLinesReply answers one recall-lines query: the workspace mirror's
// rows, newest first.
type recallLinesReply struct {
	Items []fleet.RecallLine `json:"items"`
}

// handleSessionRecallLines serves the session workspace's recall mirror: the
// typed prompts submitted through swarm there, newest first, so the composer
// search recalls across sessions. ?query narrows by case-insensitive
// substring and ?limit caps the page.
func (s *apiServer) handleSessionRecallLines(w http.ResponseWriter, r *http.Request) {
	limit, ok := parseLimit(w, r)
	if !ok {
		return
	}
	rows, err := s.fleet.RecallLines(r.Context(), r.PathValue("id"),
		r.URL.Query().Get("query"), limit)
	if err != nil {
		writeCommandFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, recallLinesReply{Items: orEmptySlice(rows)})
}

// handleSessionCandidates serves the rewind picker feed derived from the
// session's transcript tree, current head marked from its live snapshot.
func (s *apiServer) handleSessionCandidates(w http.ResponseWriter, r *http.Request) {
	res, err := s.fleet.Candidates(r.Context(), r.PathValue("id"))
	if err != nil {
		writeCommandFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// handleSessionSnapshot serves the actor's reconciled state for polling
// clients, the same shape a stream init carries plus the seq watermark it was
// read under: events at or below it are already covered by these fields.
func (s *apiServer) handleSessionSnapshot(w http.ResponseWriter, r *http.Request) {
	snap, err := s.fleet.Snapshot(r.Context(), r.PathValue("id"))
	if err != nil {
		writeCommandFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

// filesReply answers one @-completion query for the composer.
type filesReply struct {
	Items []fleet.FileSuggestion `json:"items"`
}

// handleSessionFiles completes @ file paths against the session's working
// directory; an unreadable target answers empty rather than failing.
func (s *apiServer) handleSessionFiles(w http.ResponseWriter, r *http.Request) {
	items, err := s.fleet.Files(r.Context(), r.PathValue("id"), r.URL.Query().Get("query"))
	if err != nil {
		writeCommandFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, filesReply{Items: items})
}

// handleAttention serves the per-live-session digest behind the focus rail
// and notification badges; no session stream is subscribed anywhere.
func (s *apiServer) handleAttention(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.fleet.Attention())
}

// handleModels serves the models listing: one row per live session whose
// current model comes from its snapshot. Switching goes through POST /model
// against the same registry models.get lists.
func (s *apiServer) handleModels(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, orEmptySlice(s.fleet.ModelRows(r.Context())))
}
