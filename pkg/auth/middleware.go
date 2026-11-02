package auth

import (
	"encoding/json"
	"net/http"
	"strings"
)

// Middleware gates API requests. Before a password exists only the bootstrap
// endpoint passes and everything else answers with the bootstrap-required
// marker; afterwards a valid session cookie or bearer token is required.
// Exempt routes still receive a principal when credentials are valid, so they
// answer for themselves instead of being rejected here.
func (s *Service) Middleware(exempt func(*http.Request) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if s.BootstrapRequired() {
				if r.URL.Path == BootstrapPath {
					next.ServeHTTP(w, r)
					return
				}
				writeGateError(w, http.StatusServiceUnavailable, "bootstrap_required")
				return
			}

			p, renewed, ok := s.authenticate(r)
			if !ok {
				if exempt != nil && exempt(r) {
					next.ServeHTTP(w, r)
					return
				}
				writeGateError(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			if renewed {
				http.SetCookie(w, s.SessionCookie(cookieValue(r)))
			}
			next.ServeHTTP(w, r.WithContext(WithPrincipal(r.Context(), p)))
		})
	}
}

// authenticate accepts a valid session cookie or bearer token. Both candidates
// are tried so a script can present a fresh token alongside a stale cookie.
func (s *Service) authenticate(r *http.Request) (Principal, bool, bool) {
	if c, err := r.Cookie(SessionCookieName); err == nil && c.Value != "" {
		p, renewed, err := s.Session(r.Context(), c.Value)
		if err == nil {
			return p, renewed, true
		}
	}
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		raw := strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
		if raw != "" {
			p, err := s.Bearer(r.Context(), raw)
			if err == nil {
				return p, false, true
			}
		}
	}
	return Principal{}, false, false
}

// cookieValue reads the current session token back out of the request.
func cookieValue(r *http.Request) string {
	c, err := r.Cookie(SessionCookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

// writeGateError answers with the standard error envelope. Kept beside the
// middleware so gating never depends on the handler layer below it.
func writeGateError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}
