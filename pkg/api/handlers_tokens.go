package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/jentfoo/ajent-swarm/pkg/auth"
)

// tokenBody is the API shape of one API token: no hash ever leaves.
type tokenBody struct {
	Name      string `json:"name"`
	CreatedAt string `json:"createdAt"` // RFC 3339, empty when unset
	LastUsed  string `json:"lastUsed"`  // RFC 3339, empty when never used
}

// rfcTime renders stored timestamps; the zero time stays empty.
func rfcTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
}

// handleTokenList lists every bearer token without secrets.
func (s *apiServer) handleTokenList(w http.ResponseWriter, r *http.Request) {
	toks, err := s.auth.Tokens(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "listing tokens failed")
		return
	}
	out := make([]tokenBody, len(toks))
	for i, tok := range toks {
		out[i] = tokenBody{Name: tok.Name, CreatedAt: rfcTime(tok.CreatedAt), LastUsed: rfcTime(tok.LastUsed)}
	}
	writeJSON(w, http.StatusOK, out)
}

// handleTokenCreate mints one bearer token; the plaintext secret appears only
// in this response.
func (s *apiServer) handleTokenCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if !readRequest(w, r, &req) {
		return
	}

	secret, err := s.auth.CreateToken(r.Context(), req.Name)
	if errors.Is(err, auth.ErrTokenNameTaken) {
		writeError(w, http.StatusConflict, "name_taken", "")
		return
	} else if err != nil {
		// token-name validation failures surface here as request problems
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"name": req.Name, "token": secret})
}

// handleTokenDelete revokes one token by name.
func (s *apiServer) handleTokenDelete(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := auth.ValidateTokenName(name); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	removed, err := s.auth.DeleteToken(r.Context(), name)
	switch {
	case err != nil:
		writeError(w, http.StatusInternalServerError, "internal_error", "delete failed")
	case !removed:
		writeError(w, http.StatusNotFound, "not_found", "")
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}
