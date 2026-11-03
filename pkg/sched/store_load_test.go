package sched

import (
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent-swarm/pkg/store"
)

// Phase 12 check: WAL stays healthy while the trigger loop fires jobs and
// concurrent readers hammer the same database. Every operation must answer
// without a busy or locked error.
func TestSQLiteStaysHealthyUnderSchedulerLoad(t *testing.T) {
	if testing.Short() {
		t.Skip("store load check skipped in -short runs")
	}

	st, err := store.Open(filepath.Join(t.TempDir(), store.FileName))
	require.NoError(t, err)
	t.Cleanup(func() { _ = st.Close() })

	ctx := t.Context()
	h := newHarness(t, nil)
	h.store = st
	h.sched = New(Options{Log: testLogger(), Store: st, Runner: h.runner, Tick: 20 * time.Millisecond})
	jobID := h.addJob("wal-load", nil)

	h.start(ctx)

	// three readers plus one writer churn beside the trigger loop
	errs := make(chan error, 4)
	done := make(chan struct{})
	var wg sync.WaitGroup
	for range 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-done:
					return
				default:
				}
				if _, err := st.Runs(ctx, jobID, 100); err != nil {
					errs <- err
					return
				}
				if _, err := st.Jobs(ctx); err != nil {
					errs <- err
					return
				}
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		jid := jobID
		for i := 0; i < 200; i++ {
			now := time.Now()
			if _, err := st.BeginManualRun(ctx, jid, false, 1000, store.Run{
				JobID: &jid, Trigger: store.TriggerManual, Status: store.RunOK,
				StartedAt: now, FinishedAt: &now,
			}); err != nil {
				errs <- err
				return
			}
		}
	}()

	var writeErr error
	require.Eventually(t, func() bool {
		select {
		case writeErr = <-errs:
			return true
		default:
		}
		rows, err := st.Runs(ctx, jobID, 10000)
		return err == nil && len(rows) >= 50
	}, 5*time.Second, 20*time.Millisecond, "the writer kept landing rows while the loop fired")
	if writeErr != nil {
		t.Fatalf("writer failed mid-run: %v", writeErr)
	}

	close(done)
	wg.Wait()
	close(errs)
	for err := range errs {
		assert.NoError(t, err, "no operation may fail while the trigger loop runs")
	}
}
