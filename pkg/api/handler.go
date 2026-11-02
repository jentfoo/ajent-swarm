// Package api serves the swarm control surface over HTTP: auth endpoints, a
// method-pattern route table under /api and the embedded SPA at root.
package api

import (
	"log/slog"
	"net/http"

	"github.com/jentfoo/ajent-swarm/pkg/auth"
	"github.com/jentfoo/ajent-swarm/pkg/web"
)

// API paths that need no credential. The bootstrap endpoint is handled inside
// the auth middleware; login and me answer for themselves.
const (
	pathLogin = "/api/auth/login"
	pathMe    = "/api/me"
)

// apiMethods lists every registered method-specific API path with the
// methods it accepts, so wrong-method requests can still answer 405.
var apiMethods = map[string]string{
	pathLogin:          http.MethodPost,
	"/api/auth/logout": http.MethodPost,
	pathMe:             http.MethodGet,
	auth.BootstrapPath: http.MethodPost,

	"/api/tokens":        "GET, POST",
	"/api/tokens/{name}": http.MethodDelete,
}

// Config wires the API handler to its collaborators; all fields are required.
type Config struct {
	Auth                 *auth.Service
	AllowRemoteBootstrap bool // --allow-remote-bootstrap: non-loopback may set the first password
	Log                  *slog.Logger
}

// apiServer carries the collaborators every handler needs.
type apiServer struct {
	auth                 *auth.Service
	allowRemoteBootstrap bool
}

// Handler builds the full HTTP handler: request logging and panic recovery
// around an API subtree gated by auth, plus the SPA at root. Static assets
// stay reachable so the login page can render in every bootstrap state.
func Handler(cfg Config) http.Handler {
	srv := &apiServer{auth: cfg.Auth, allowRemoteBootstrap: cfg.AllowRemoteBootstrap}

	apiMux := http.NewServeMux()
	apiMux.HandleFunc("POST "+pathLogin, srv.handleLogin)
	apiMux.HandleFunc("POST /api/auth/logout", srv.handleLogout)
	apiMux.HandleFunc("GET "+pathMe, srv.handleMe)
	apiMux.HandleFunc("POST "+auth.BootstrapPath, srv.handleBootstrap)

	apiMux.HandleFunc("GET /api/tokens", srv.handleTokenList)
	apiMux.HandleFunc("POST /api/tokens", srv.handleTokenCreate)
	apiMux.HandleFunc("DELETE /api/tokens/{name}", srv.handleTokenDelete)

	// unmatched API paths answer as JSON, never as the SPA document; a known
	// path hit with the wrong method answers 405, since the method-specific
	// patterns above do not match and would otherwise land here as a 404
	apiMux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		if methods, ok := apiMethods[r.URL.Path]; ok {
			w.Header().Set("Allow", methods)
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "")
			return
		}
		writeError(w, http.StatusNotFound, "not_found", "")
	})

	root := http.NewServeMux()
	root.Handle("/api/", cfg.Auth.Middleware(exemptFromAuth)(apiMux))
	root.Handle("/", web.Handler())

	return logRequests(cfg.Log)(recoverPanics(cfg.Log)(root))
}

// exemptFromAuth lists the requests the gate lets through once a password
// exists. Login and me are status probes; bootstrap stays listed so an
// already-bootstrapped service can answer 409 instead of 401.
func exemptFromAuth(r *http.Request) bool {
	switch r.URL.Path {
	case pathLogin, auth.BootstrapPath, pathMe:
		return true
	default:
		return false
	}
}

// recoverPanics turns handler panics into clean 500s with the stack logged.
func recoverPanics(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ww := &responseWriter{ResponseWriter: w}
			defer func() {
				if rec := recover(); rec != nil {
					log.Error("handler panic", "path", r.URL.Path, "panic", rec)
					if !ww.wrote {
						writeError(ww, http.StatusInternalServerError, "internal_error", "")
					}
				}
			}()
			next.ServeHTTP(ww, r)
		})
	}
}

// logRequests records one line per request with its final status.
func logRequests(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ww := &responseWriter{ResponseWriter: w}
			next.ServeHTTP(ww, r)
			log.Info("request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", ww.status,
				"remote", r.RemoteAddr)
		})
	}
}

// responseWriter tracks whether headers went out and forwards the interfaces
// later phases need (flushing, connection hijacking for websockets).
type responseWriter struct {
	http.ResponseWriter
	wrote  bool
	status int
}

func (w *responseWriter) WriteHeader(status int) {
	if !w.wrote {
		w.status = status
		w.wrote = true
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *responseWriter) Write(b []byte) (int, error) {
	if !w.wrote {
		w.status = http.StatusOK
		w.wrote = true
	}
	return w.ResponseWriter.Write(b)
}

// Unwrap supports http.ResponseController lookups through the wrapper.
func (w *responseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
