package api

import (
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jentfoo/ajent-swarm/pkg/auth"
)

// handleLogin verifies credentials and issues the session cookie. Failed
// attempts spend a per-source budget so password guessing stays slow.
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
	key := remoteKey(r)
	if !s.loginLimiter.Allow(key) {
		writeRetryAfter(w, s.loginLimiter.RetryAfter(key))
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
	s.loginLimiter.Reset(key)
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
	p, ok := auth.PrincipalFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "")
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "" // no home to fold paths against; clients show absolutes
	}
	writeJSON(w, http.StatusOK, meReply{Username: p.Username, Via: p.Via, Home: home})
}

// handleBootstrap sets the first password. Loopback peers only unless
// --allow-remote-bootstrap says otherwise. Guessing shares the login budget:
// a failed bootstrap is a failed credential attempt.
func (s *apiServer) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	key := remoteKey(r)
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
	if !s.loginLimiter.Allow(key) {
		writeRetryAfter(w, s.loginLimiter.RetryAfter(key))
		return
	}

	err := s.auth.Bootstrap(r.Context(), req.Password)
	switch {
	case errors.Is(err, auth.ErrAlreadyBootstrapped):
		writeError(w, http.StatusConflict, "already_bootstrapped", "")
		return
	case errors.Is(err, auth.ErrPasswordTooLong):
		writeError(w, http.StatusBadRequest, "invalid_request",
			fmt.Sprintf("password must be at most %d bytes", auth.MaxPasswordBytes))
		return
	case err != nil:
		writeError(w, http.StatusInternalServerError, "internal_error", "bootstrap failed")
		return
	}
	s.loginLimiter.Reset(key)
	w.WriteHeader(http.StatusNoContent)
}

// remoteKey names the request's source address for rate limiting. An
// unparseable RemoteAddr falls back to the raw value, so every request still
// lands in some budget.
func remoteKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// writeRetryAfter answers 429 with the standard envelope and a header naming
// when the budget reopens.
func writeRetryAfter(w http.ResponseWriter, wait time.Duration) {
	secs := int(math.Ceil(wait.Seconds()))
	if secs < 1 {
		secs = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(secs))
	writeError(w, http.StatusTooManyRequests, "rate_limited",
		"too many failed attempts; retry later")
}

// isLoopback reports whether the request arrived from a loopback peer.
func isLoopback(r *http.Request) bool {
	host := r.RemoteAddr
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// secureCookie marks a cookie Secure when the request arrived over TLS or
// through a reverse proxy that terminated it, so remote logins keep the
// credential off plaintext hops. Direct HTTP stays without the flag: an
// unencrypted origin cannot honor it anyway.
func secureCookie(r *http.Request, c *http.Cookie) *http.Cookie {
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		c.Secure = true
	}
	return c
}
