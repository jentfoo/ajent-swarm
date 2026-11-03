package auth

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"

	"github.com/go-analyze/bulk"
)

// Middleware gates API requests. Before a password exists only the bootstrap
// endpoint passes and everything else answers with the bootstrap-required
// marker; afterwards a valid session cookie or bearer token is required.
// Cookie-authenticated state-changing calls must additionally pass a Fetch
// Metadata check (crossSiteWriteBlocked). Exempt routes still receive a
// principal when credentials are valid, so they answer for themselves instead
// of being rejected here. exempt must be provided; callers without exemptions
// pass a func returning false.
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
				if exempt(r) {
					next.ServeHTTP(w, r)
					return
				}
				writeGateError(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			// Bearer callers skip the check: no ambient credential to ride.
			if p.Via == ViaCookie && crossSiteWriteBlocked(r) {
				writeGateError(w, http.StatusForbidden, "cross_site_blocked")
				return
			}
			if renewed {
				c, err := r.Cookie(SessionCookieName) // renewed implies the cookie path
				if err == nil {
					http.SetCookie(w, s.SessionCookie(c.Value))
				}
			}
			next.ServeHTTP(w, r.WithContext(withPrincipal(r.Context(), p)))
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

// unsafeMethods are the state-changing methods a CSRF can ride; reads cannot
// inspect cross-origin responses, so they stay open.
var unsafeMethods = []string{
	http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch,
}

// safeFetchSites are the Sec-Fetch-Site values accepted on state-changing
// calls; same-site stays rejected since the SPA is always same-origin, so a
// sibling subdomain has no legitimate use.
var safeFetchSites = bulk.SliceToSet([]string{"same-origin", "none"})

// crossSiteWriteBlocked reports whether Fetch Metadata marks the request as a
// state-changing call initiated from another site. Current browsers always
// attach Sec-Fetch-Site and page script cannot forge it, so its absence means
// a non-browser client; blocking here closes the Lax+POST window SameSite=Lax
// leaves open right after login.
func crossSiteWriteBlocked(r *http.Request) bool {
	if !slices.Contains(unsafeMethods, r.Method) {
		return false
	}
	site := r.Header.Get("Sec-Fetch-Site")
	if site == "" { // non-browser clients never send it
		return false
	}
	_, safe := safeFetchSites[site]
	return !safe
}

// writeGateError answers with the standard error envelope.
func writeGateError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}
