package fleet

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent/pkg/ctl"
)

// TestMailboxCall pins the call contract against a stopped actor: accepted
// calls fail fast once done closes instead of waiting on the caller's ctx,
// which may be detached bookkeeping that never cancels.
func TestMailboxCall(t *testing.T) {
	t.Parallel()

	newStoppedActor := func(t *testing.T) *sessionActor {
		t.Helper()
		m := New(Options{Log: testLogger(), Discover: func() ([]ctl.Instance, error) { return nil, nil }})
		m.Start(t.Context())
		t.Cleanup(m.Stop)
		return newSessionActor(m, ctl.Instance{SessionID: "01TESTACTOR00"})
	}

	t.Run("shutdown_unblocks_pending_call", func(t *testing.T) {
		a := newStoppedActor(t)

		errCh := make(chan error, 1)
		go func() { // the send lands in the buffered mailbox; no run loop replies
			_, err := mailboxCall(t.Context(), a,
				func(reply chan error) actorMsg { return msgStop{reply: reply} })
			errCh <- err
		}()
		close(a.done) // an exit path can orphan accepted calls unreplied

		// close(a.done) deterministically unblocks the pending call
		err := <-errCh
		require.ErrorContains(t, err, "shutting down")
	})

	t.Run("cancelled_ctx_returns_promptly", func(t *testing.T) {
		a := newStoppedActor(t)

		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		_, err := mailboxCall(ctx, a,
			func(reply chan error) actorMsg { return msgStop{reply: reply} })
		assert.ErrorIs(t, err, context.Canceled)
	})
}
