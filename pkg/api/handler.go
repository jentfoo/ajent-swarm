// Package api serves the swarm control surface over HTTP: auth endpoints, a
// method-pattern route table under /api and the embedded SPA at root.
package api

import (
	"bufio"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/jentfoo/ajent-swarm/pkg/auth"
	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	"github.com/jentfoo/ajent-swarm/pkg/sched"
	"github.com/jentfoo/ajent-swarm/pkg/web"
)

// API paths needing no credential.
const (
	pathLogin = "/api/auth/login"
	pathMe    = "/api/me"
)

// Config wires the API handler to its collaborators; all fields are required.
type Config struct {
	Auth                 *auth.Service
	Fleet                *fleet.Manager   // session listing, streams and commands
	Sched                *sched.Scheduler // job CRUD, manual fires and run history
	AttachmentsDir       string           // where composer uploads land for @-reference submits
	AllowRemoteBootstrap bool             // non-loopback may set the first password
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

// Handler builds the full HTTP handler: security headers, request logging
// and panic recovery around an API subtree gated by auth, plus the SPA at
// root. Static assets stay reachable so the login page can render in every
// bootstrap state.
func Handler(cfg Config) http.Handler {
	srv := &apiServer{
		auth:                 cfg.Auth,
		fleet:                cfg.Fleet,
		sched:                cfg.Sched,
		attachmentsDir:       cfg.AttachmentsDir,
		allowRemoteBootstrap: cfg.AllowRemoteBootstrap,
		loginLimiter:         auth.NewFailLimiter(loginFailuresAllowed, loginWindow),
	}

	// one route table: the mux registers from it and wrong-method requests
	// answer 405 with the path's full Allow set
	allow := map[string]string{}
	apiMux := http.NewServeMux()
	for _, rt := range []struct {
		method, path string
		handle       func(http.ResponseWriter, *http.Request)
	}{
		{http.MethodPost, pathLogin, srv.handleLogin},
		{http.MethodPost, "/api/auth/logout", srv.handleLogout},
		{http.MethodGet, pathMe, srv.handleMe},
		{http.MethodPost, auth.BootstrapPath, srv.handleBootstrap},

		{http.MethodGet, "/api/stream", srv.handleStream},
		{http.MethodGet, "/api/sessions", srv.handleSessionList},
		{http.MethodPost, "/api/sessions", srv.handleLaunch},
		{http.MethodGet, "/api/sessions/{id}/entries", srv.handleSessionEntries},
		{http.MethodPost, "/api/sessions/{id}/stop", srv.handleStop},
		{http.MethodPost, "/api/sessions/{id}/take-control", srv.handleTakeControl},
		{http.MethodPost, "/api/sessions/{id}/submit", srv.handleSessionSubmit},
		{http.MethodPost, "/api/sessions/{id}/interrupt", srv.handleSessionInterrupt},
		{http.MethodPost, "/api/sessions/{id}/mode", srv.handleSessionMode},
		{http.MethodPost, "/api/sessions/{id}/rewind", srv.handleSessionRewind},
		{http.MethodPost, "/api/sessions/{id}/resolve", srv.handleSessionResolve},
		{http.MethodPost, "/api/sessions/{id}/recall", srv.handleSessionRecall},
		{http.MethodGet, "/api/sessions/{id}/candidates", srv.handleSessionCandidates},
		{http.MethodGet, "/api/sessions/{id}/snapshot", srv.handleSessionSnapshot},
		{http.MethodGet, "/api/sessions/{id}/files", srv.handleSessionFiles},
		{http.MethodPost, "/api/sessions/{id}/attachments", srv.handleSessionAttachment},
		{http.MethodGet, "/api/sessions/{id}/models", srv.handleSessionModels},
		{http.MethodPost, "/api/sessions/{id}/model", srv.handleSessionModelSet},
		{http.MethodPost, "/api/sessions/{id}/tools", srv.handleSessionTools},
		{http.MethodGet, "/api/sessions/{id}/settings", srv.handleSessionSettings},
		{http.MethodPost, "/api/sessions/{id}/setting", srv.handleSessionSettingSet},
		{http.MethodPost, "/api/sessions/{id}/title", srv.handleSessionTitle},
		{http.MethodGet, "/api/attention", srv.handleAttention},
		{http.MethodGet, "/api/models", srv.handleModels},
		{http.MethodGet, "/api/models/options", srv.handleModelOptions},
		{http.MethodGet, "/api/tools/options", srv.handleToolOptions},
		{http.MethodGet, "/api/settings", srv.handleSettingsGet},
		{http.MethodPut, "/api/settings", srv.handleSettingsSet},
		{http.MethodGet, "/api/saved-sessions", srv.handleSavedSessions},
		{http.MethodGet, "/api/saved-sessions/{id}/entries", srv.handleSavedEntries},

		{http.MethodGet, "/api/jobs", srv.handleJobList},
		{http.MethodPost, "/api/jobs", srv.handleJobCreate},
		{http.MethodGet, "/api/jobs/{id}", srv.handleJobGet},
		{http.MethodPut, "/api/jobs/{id}", srv.handleJobUpdate},
		{http.MethodDelete, "/api/jobs/{id}", srv.handleJobDelete},
		{http.MethodPost, "/api/jobs/{id}/run", srv.handleJobFire},
		{http.MethodPost, "/api/jobs/preview", srv.handleJobPreview},
		{http.MethodGet, "/api/runs", srv.handleRuns},

		{http.MethodGet, "/api/tokens", srv.handleTokenList},
		{http.MethodPost, "/api/tokens", srv.handleTokenCreate},
		{http.MethodDelete, "/api/tokens/{name}", srv.handleTokenDelete},
	} {
		apiMux.HandleFunc(rt.method+" "+rt.path, rt.handle)
		if seen := allow[rt.path]; seen == "" {
			allow[rt.path] = rt.method
		} else {
			allow[rt.path] = seen + ", " + rt.method
		}
	}

	// unmatched API paths answer as JSON, never as the SPA document; a known
	// path hit with the wrong method answers 405, since the method-specific
	// patterns above do not match and would otherwise land here as a 404
	apiMux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		if methods, ok := allow[r.URL.Path]; ok {
			w.Header().Set("Allow", methods)
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "")
			return
		}
		writeError(w, http.StatusNotFound, "not_found", "")
	})

	root := http.NewServeMux()
	root.Handle("/api/", cfg.Auth.Middleware(exemptFromAuth)(apiMux))
	root.Handle("/", web.Handler())

	return logRequests(cfg.Log)(recoverPanics(cfg.Log)(securityHeaders(root)))
}

// securityHeaders sets the baseline protection headers on every response.
// API results carry session state and transcripts, so they also opt out of
// caching; static assets keep default cacheability for their hashed names.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
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

// responseWriter tracks whether headers went out and passes websocket
// hijack requests through.
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
