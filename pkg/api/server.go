package api

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"
)

// drainWait bounds graceful shutdown so a wedged client cannot hang exit.
const drainWait = 5 * time.Second

// NewServer builds the http.Server with timeouts that leave room for the
// long-lived stream endpoint arriving in the fleet phase: no global write or
// read deadline, only header and idle limits.
func NewServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
	}
}

// Serve accepts connections until ctx is cancelled, then drains in-flight
// requests under a bounded wait. A listener failure returns its error; a
// signal always leads to a clean return.
func Serve(ctx context.Context, srv *http.Server, ln net.Listener, log *slog.Logger) error {
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()

	select {
	case err := <-serveErr:
		return fmt.Errorf("serve %s: %w", ln.Addr(), err)
	case <-ctx.Done():
	}

	// detached from the cancelled serve context but still value-carrying
	dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), drainWait)
	defer cancel()
	if err := srv.Shutdown(dctx); err != nil {
		log.Warn("graceful shutdown timed out; closing remaining connections", "err", err)
		_ = srv.Close()
	}
	return nil
}
