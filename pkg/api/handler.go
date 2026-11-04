// Package api serves the swarm control surface over HTTP: auth endpoints, a
// method-pattern route table under /api and the embedded SPA at root.
package api

import (
	"bufio"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/jentfoo/ajent-swarm/pkg/auth"
	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	"github.com/jentfoo/ajent-swarm/pkg/sched"
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

	"/api/stream":                      http.MethodGet,
	"/api/sessions":                    "GET, POST",
	"/api/sessions/{id}/entries":       http.MethodGet,
	"/api/sessions/{id}/stop":          http.MethodPost,
	"/api/sessions/{id}/take-control":  http.MethodPost,
	"/api/sessions/{id}/submit":        http.MethodPost,
	"/api/sessions/{id}/interrupt":     http.MethodPost,
	"/api/sessions/{id}/mode":          http.MethodPost,
	"/api/sessions/{id}/rewind":        http.MethodPost,
	"/api/sessions/{id}/resolve":       http.MethodPost,
	"/api/sessions/{id}/recall":        http.MethodPost,
	"/api/sessions/{id}/candidates":    http.MethodGet,
	"/api/sessions/{id}/snapshot":      http.MethodGet,
	"/api/sessions/{id}/files":         http.MethodGet,
	"/api/sessions/{id}/attachments":   http.MethodPost,
	"/api/sessions/{id}/models":        http.MethodGet,
	"/api/sessions/{id}/model":         http.MethodPost,
	"/api/sessions/{id}/tools":         http.MethodPost,
	"/api/sessions/{id}/settings":      http.MethodGet,
	"/api/sessions/{id}/setting":       http.MethodPost,
	"/api/sessions/{id}/title":         http.MethodPost,
	"/api/attention":                   http.MethodGet,
	"/api/models":                      http.MethodGet,
	"/api/models/options":              http.MethodGet,
	"/api/tools/options":               http.MethodGet,
	"/api/settings":                    "GET, PUT",
	"/api/saved-sessions":              http.MethodGet,
	"/api/saved-sessions/{id}/entries": http.MethodGet,

	"/api/jobs":          "GET, POST",
	"/api/jobs/{id}":     "GET, PUT, DELETE",
	"/api/jobs/{id}/run": http.MethodPost,
	"/api/jobs/preview":  http.MethodPost,
	"/api/runs":          http.MethodGet,

	"/api/tokens":        "GET, POST",
	"/api/tokens/{name}": http.MethodDelete,
}

// Config wires the API handler to its collaborators; all fields are required.
type Config struct {
	Auth                 *auth.Service
	Fleet                *fleet.Manager   // session listing, streams and commands
	Sched                *sched.Scheduler // job CRUD, manual fires and run history
	AttachmentsDir       string           // where composer uploads land for @-reference submits
	AllowRemoteBootstrap bool             // --allow-remote-bootstrap: non-loopback may set the first password
	Log                  *slog.Logger
}

// apiServer carries the collaborators every handler needs.
type apiServer struct {
	auth                 *auth.Service
	fleet                *fleet.Manager
	sched                *sched.Scheduler
	attachmentsDir       string
	allowRemoteBootstrap bool
	loginLimiter         *auth.FailLimiter // failed-login budget per source address
}

// limiterDefaults bound failed credential attempts per source address.
const (
	loginFailuresAllowed = 10
	loginWindow          = 5 * time.Minute
)

// Handler builds the full HTTP handler: request logging and panic recovery
// around an API subtree gated by auth, plus the SPA at root. Static assets
// stay reachable so the login page can render in every bootstrap state.
func Handler(cfg Config) http.Handler {
	srv := &apiServer{
		auth:                 cfg.Auth,
		fleet:                cfg.Fleet,
		sched:                cfg.Sched,
		attachmentsDir:       cfg.AttachmentsDir,
		allowRemoteBootstrap: cfg.AllowRemoteBootstrap,
		loginLimiter:         auth.NewFailLimiter(loginFailuresAllowed, loginWindow),
	}

	apiMux := http.NewServeMux()
	apiMux.HandleFunc("POST "+pathLogin, srv.handleLogin)
	apiMux.HandleFunc("POST /api/auth/logout", srv.handleLogout)
	apiMux.HandleFunc("GET "+pathMe, srv.handleMe)
	apiMux.HandleFunc("POST "+auth.BootstrapPath, srv.handleBootstrap)

	apiMux.HandleFunc("GET /api/stream", srv.handleStream)
	apiMux.HandleFunc("GET /api/sessions", srv.handleSessionList)
	apiMux.HandleFunc("POST /api/sessions", srv.handleLaunch)
	apiMux.HandleFunc("GET /api/sessions/{id}/entries", srv.handleSessionEntries)
	apiMux.HandleFunc("POST /api/sessions/{id}/stop", srv.handleStop)
	apiMux.HandleFunc("POST /api/sessions/{id}/take-control", srv.handleTakeControl)
	apiMux.HandleFunc("POST /api/sessions/{id}/submit", srv.handleSessionSubmit)
	apiMux.HandleFunc("POST /api/sessions/{id}/interrupt", srv.handleSessionInterrupt)
	apiMux.HandleFunc("POST /api/sessions/{id}/mode", srv.handleSessionMode)
	apiMux.HandleFunc("POST /api/sessions/{id}/rewind", srv.handleSessionRewind)
	apiMux.HandleFunc("POST /api/sessions/{id}/resolve", srv.handleSessionResolve)
	apiMux.HandleFunc("POST /api/sessions/{id}/recall", srv.handleSessionRecall)
	apiMux.HandleFunc("GET /api/sessions/{id}/candidates", srv.handleSessionCandidates)
	apiMux.HandleFunc("GET /api/sessions/{id}/snapshot", srv.handleSessionSnapshot)
	apiMux.HandleFunc("GET /api/sessions/{id}/files", srv.handleSessionFiles)
	apiMux.HandleFunc("POST /api/sessions/{id}/attachments", srv.handleSessionAttachment)
	apiMux.HandleFunc("GET /api/sessions/{id}/models", srv.handleSessionModels)
	apiMux.HandleFunc("POST /api/sessions/{id}/model", srv.handleSessionModelSet)
	apiMux.HandleFunc("POST /api/sessions/{id}/tools", srv.handleSessionTools)
	apiMux.HandleFunc("GET /api/sessions/{id}/settings", srv.handleSessionSettings)
	apiMux.HandleFunc("POST /api/sessions/{id}/setting", srv.handleSessionSettingSet)
	apiMux.HandleFunc("POST /api/sessions/{id}/title", srv.handleSessionTitle)
	apiMux.HandleFunc("GET /api/attention", srv.handleAttention)
	apiMux.HandleFunc("GET /api/models", srv.handleModels)
	apiMux.HandleFunc("GET /api/models/options", srv.handleModelOptions)
	apiMux.HandleFunc("GET /api/tools/options", srv.handleToolOptions)
	apiMux.HandleFunc("GET /api/settings", srv.handleSettingsGet)
	apiMux.HandleFunc("PUT /api/settings", srv.handleSettingsSet)
	apiMux.HandleFunc("GET /api/saved-sessions", srv.handleSavedSessions)
	apiMux.HandleFunc("GET /api/saved-sessions/{id}/entries", srv.handleSavedEntries)

	apiMux.HandleFunc("GET /api/jobs", srv.handleJobList)
	apiMux.HandleFunc("POST /api/jobs", srv.handleJobCreate)
	apiMux.HandleFunc("GET /api/jobs/{id}", srv.handleJobGet)
	apiMux.HandleFunc("PUT /api/jobs/{id}", srv.handleJobUpdate)
	apiMux.HandleFunc("DELETE /api/jobs/{id}", srv.handleJobDelete)
	apiMux.HandleFunc("POST /api/jobs/{id}/run", srv.handleJobFire)
	apiMux.HandleFunc("POST /api/jobs/preview", srv.handleJobPreview)
	apiMux.HandleFunc("GET /api/runs", srv.handleRuns)

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

// Hijack passes through so a WebSocket upgrade inside a wrapped handler can
// take over the connection.
func (w *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("response writer does not support hijacking")
	}
	w.wrote = true
	return h.Hijack()
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
