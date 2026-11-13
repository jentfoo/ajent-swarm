package api

import (
	"context"
	"net"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestServe(t *testing.T) {
	t.Parallel()

	t.Run("shuts_down_cleanly", func(t *testing.T) {
		svc := newTestService(t)
		var lc net.ListenConfig
		ln, err := lc.Listen(t.Context(), "tcp", "127.0.0.1:0")
		require.NoError(t, err)

		srv := NewServer(Handler(Config{Auth: svc, Fleet: newTestFleet(t), Log: testLogger()}))
		ctx, cancel := context.WithCancel(t.Context())
		serveErr := make(chan error, 1)
		go func() { serveErr <- Serve(ctx, srv, ln, testLogger()) }()

		cancel()
		assert.NoError(t, <-serveErr)
	})

	t.Run("reports_listener_failure", func(t *testing.T) {
		var lc net.ListenConfig
		ln, err := lc.Listen(t.Context(), "tcp", "127.0.0.1:0")
		require.NoError(t, err)

		// serving on an already-closed listener fails at once, a live listener
		// would block here until its context cancels
		require.NoError(t, ln.Close())
		srv := NewServer(http.NewServeMux())
		err = Serve(t.Context(), srv, ln, testLogger())
		assert.Error(t, err)
	})
}
