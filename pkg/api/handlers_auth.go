package api

import (
	"errors"
	"net/http"
	"os"

	"github.com/jentfoo/ajent-swarm/pkg/auth"
)

// handleLogin verifies credentials and issues the session cookie.
func (s *apiServer) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !readRequest(w, r, &req) {
		return
	}
	if req.Username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "username and password are required")
		return
	}

	token, err := s.auth.Login(r.Context(), req.Username, req.Password)
	if errors.Is(err, auth.ErrInvalidCredentials) {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "login failed")
		return
	}
	http.SetCookie(w, secureCookie(r, s.auth.SessionCookie(token)))
	w.WriteHeader(http.StatusNoContent)
}

// handleLogout deletes the session row and expires the cookie.
func (s *apiServer) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(auth.SessionCookieName); err == nil && c.Value != "" {
		_ = s.auth.Logout(r.Context(), c.Value)
	}
	http.SetCookie(w, secureCookie(r, s.auth.ClearSessionCookie()))
	w.WriteHeader(http.StatusNoContent)
}

// meReply is the GET /api/me answer. Home is the service host's home
// directory, so clients can render workspace paths relative to ~.
type meReply struct {
	Username string `json:"username"`
	Via      string `json:"via"`
	Home     string `json:"home,omitempty"`
}

// handleMe reports the authenticated principal; unauthenticated callers get
// 401 so the placeholder page can pick its form.
func (s *apiServer) handleMe(w http.ResponseWriter, r *http.Request) {
	p, ok := principalOrUnauthorized(w, r)
	if !ok {
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "" // no home to fold paths against; clients show absolutes
	}
	writeJSON(w, http.StatusOK, meReply{Username: p.Username, Via: p.Via, Home: home})
}

// handleBootstrap sets the first password. Loopback peers only unless
// --allow-remote-bootstrap says otherwise.
func (s *apiServer) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	if !s.allowRemoteBootstrap && !isLoopback(r) {
		writeError(w, http.StatusForbidden, "remote_bootstrap_forbidden",
			"the first password can be set from loopback only; pass --allow-remote-bootstrap for remote setups")
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if !readRequest(w, r, &req) {
		return
	}
	if req.Password == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "a password is required")
		return
	}

	err := s.auth.Bootstrap(r.Context(), req.Password)
	switch {
	case errors.Is(err, auth.ErrAlreadyBootstrapped):
		writeError(w, http.StatusConflict, "already_bootstrapped", "")
	case err != nil:
		writeError(w, http.StatusInternalServerError, "internal_error", "bootstrap failed")
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}
