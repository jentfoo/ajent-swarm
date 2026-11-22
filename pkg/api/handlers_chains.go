package api

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"

	"github.com/jentfoo/ajent-swarm/pkg/fleet"
)

// chainRequest is the POST /api/sessions/{id}/chain body beside the PATCH
// edit body: the path names the parent, childId rides the create only.
type chainRequest struct {
	ChildID     string `json:"childId"`
	FinalPrompt string `json:"finalPrompt,omitempty"`
	ChildPrompt string `json:"childPrompt"`
	PendingID   string `json:"pendingId,omitempty"`
}

// writeChainFailure maps one chain registry refusal onto its coded response.
func writeChainFailure(w http.ResponseWriter, err error) {
	switch {
	case err == nil:
		return
	case errors.Is(err, fleet.ErrUnknownSession):
		writeError(w, http.StatusNotFound, codeSessionNotFound, "")
	case errors.Is(err, fleet.ErrChainInvalid):
		writeError(w, http.StatusBadRequest, codeChainInvalid, "chain fields are invalid")
	case errors.Is(err, fleet.ErrChainParentGone):
		writeError(w, http.StatusConflict, codeChainParentGone, err.Error())
	case errors.Is(err, fleet.ErrChainConflict), errors.Is(err, fleet.ErrChainCycle),
		errors.Is(err, fleet.ErrChainEditing):
		writeError(w, http.StatusConflict, codeChainConflict, err.Error())
	case errors.Is(err, fleet.ErrTooManyChains):
		writeError(w, http.StatusTooManyRequests, codeTooManyChains, err.Error())
	case errors.Is(err, fleet.ErrUnknownChain):
		writeError(w, http.StatusNotFound, codeChainNotFound, "")
	default:
		writeCommandFailure(w, err)
	}
}

// mintChainPending echoes the client's correlation or mints one, the same
// contract submit follows so optimistic rows resolve by id.
func mintChainPending(req chainRequest) string {
	if req.PendingID != "" {
		return req.PendingID
	}
	var b [8]byte
	rand.Read(b[:]) // crypto/rand never fails, nothing sensible to answer anyway
	return hex.EncodeToString(b[:])
}

// handleSessionChain queues one session behind another: an optional final
// prompt runs on the path's session, its response rides the child's prompt.
func (s *apiServer) handleSessionChain(w http.ResponseWriter, r *http.Request) {
	var req chainRequest
	if !readRequest(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.ChildID) == "" {
		writeError(w, http.StatusBadRequest, codeChainInvalid, "childId must not be empty")
		return
	}
	chain, err := s.fleet.CreateChain(r.Context(), r.PathValue("id"), req.ChildID,
		fleet.ChainParams{
			FinalPrompt: req.FinalPrompt,
			ChildPrompt: req.ChildPrompt,
			PendingID:   mintChainPending(req),
		})
	if err != nil {
		writeChainFailure(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, chain)
}

// handleChainUpdate edits one chain's prompts while it still sits in waiting
// or final, the registry restarts the pump under the same id. A final-state
// edit keeps the running turn's progress, so only the child prompt may
// change there.
func (s *apiServer) handleChainUpdate(w http.ResponseWriter, r *http.Request) {
	var req chainRequest
	if !readRequest(w, r, &req) {
		return
	}
	chain, err := s.fleet.UpdateChain(r.Context(), r.PathValue("id"), fleet.ChainParams{
		FinalPrompt: req.FinalPrompt,
		ChildPrompt: req.ChildPrompt,
	})
	if err != nil {
		writeChainFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, chain)
}

// handleChainCancel stops one chain before delivery.
func (s *apiServer) handleChainCancel(w http.ResponseWriter, r *http.Request) {
	if err := s.fleet.CancelChain(r.Context(), r.PathValue("id")); err != nil {
		writeChainFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleChainGet reads one chain record, so an edit opens from current
// state rather than a digest-age snapshot another device may hold.
func (s *apiServer) handleChainGet(w http.ResponseWriter, r *http.Request) {
	chain, ok := s.fleet.Chain(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, codeChainNotFound, "")
		return
	}
	writeJSON(w, http.StatusOK, chain)
}

// handleChainList snapshots every registered chain, oldest first, so any
// device can edit prompts for a live chain the digest only carries ids for.
func (s *apiServer) handleChainList(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, orEmptySlice(s.fleet.ChainList()))
}
