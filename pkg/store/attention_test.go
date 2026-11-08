package store

import (
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAckDialog(t *testing.T) {
	t.Parallel()

	t.Run("round_trips_and_refreshes", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()
		at := time.UnixMilli(1_700_000_000_000)

		require.NoError(t, st.AckDialog(ctx, "01A", 7, 42, at))
		require.NoError(t, st.AckDialog(ctx, "01A", 8, 42, at)) // twin instance, own row
		require.NoError(t, st.AckDialog(ctx, "01A", 7, 42, at.Add(time.Second)))
		require.NoError(t, st.AckDialog(ctx, "01B", 7, 42, at))

		rows, err := st.DialogAcks(ctx)
		require.NoError(t, err)
		assert.ElementsMatch(t, []DialogAck{
			{SessionID: "01A", PID: 7, DialogID: 42, AckedAt: at.Add(time.Second).UnixMilli()},
			{SessionID: "01A", PID: 8, DialogID: 42, AckedAt: at.UnixMilli()},
			{SessionID: "01B", PID: 7, DialogID: 42, AckedAt: at.UnixMilli()},
		}, rows)
	})

	t.Run("bounds_rows_per_session_oldest_dropped", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()
		base := time.UnixMilli(1_700_000_000_000)

		for i := range maxDialogAcksPerSession + 2 {
			step := base.Add(time.Duration(i) * time.Second)
			require.NoError(t, st.AckDialog(ctx, "01A", 7, uint64(i+1), step))
		}
		// another session's rows never count against this one's bound
		for i := range 10 {
			step := base.Add(time.Duration(i) * time.Second)
			require.NoError(t, st.AckDialog(ctx, "01B", 9, uint64(i+1), step))
		}

		rows, err := st.DialogAcks(ctx)
		require.NoError(t, err)
		var sessionA, sessionB []uint64
		for _, r := range rows {
			if r.SessionID == "01A" {
				sessionA = append(sessionA, r.DialogID)
			} else {
				sessionB = append(sessionB, r.DialogID)
			}
		}
		// the two oldest of 01A dropped; 01B keeps everything
		assert.Len(t, sessionA, maxDialogAcksPerSession)
		assert.NotContains(t, sessionA, uint64(1))
		assert.NotContains(t, sessionA, uint64(2))
		assert.Contains(t, sessionA, uint64(3))
		assert.Contains(t, sessionA, uint64(maxDialogAcksPerSession+2))
		assert.Len(t, sessionB, 10)
	})

	t.Run("rejects_invalid_rows", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()
		at := time.UnixMilli(1_700_000_000_000)

		require.Error(t, st.AckDialog(ctx, "  ", 7, 42, at))
		require.Error(t, st.AckDialog(ctx, "01A", 7, 0, at))

		rows, err := st.DialogAcks(ctx)
		require.NoError(t, err)
		assert.Empty(t, rows)
	})
}

func TestAckTurn(t *testing.T) {
	t.Parallel()

	t.Run("watermark_only_moves_forward", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()
		at := time.UnixMilli(1_700_000_000_000)

		require.NoError(t, st.AckTurn(ctx, "01A", 100, at))
		require.NoError(t, st.AckTurn(ctx, "01A", 50, at.Add(time.Second)))  // older never wins
		require.NoError(t, st.AckTurn(ctx, "01A", 100, at.Add(time.Second))) // equal never rewrites
		acks, err := st.TurnAcks(ctx)
		require.NoError(t, err)
		assert.Equal(t, map[string]int64{"01A": 100}, acks)

		require.NoError(t, st.AckTurn(ctx, "01A", 200, at.Add(2*time.Second)))
		require.NoError(t, st.AckTurn(ctx, "01B", 300, at))
		acks, err = st.TurnAcks(ctx)
		require.NoError(t, err)
		assert.Equal(t, map[string]int64{"01A": 200, "01B": 300}, acks)
	})

	t.Run("monotonic_under_concurrent_writes", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()
		at := time.UnixMilli(1_700_000_000_000)

		const writers = 8
		errs := make(chan error, writers*25)
		var wg sync.WaitGroup
		for w := range writers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := 1; i <= 25; i++ {
					turnEnd := int64(w*25 + i) // every writer owns one band
					if err := st.AckTurn(ctx, "01A", turnEnd, at); err != nil {
						errs <- err
						return
					}
				}
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			require.NoError(t, err)
		}

		acks, err := st.TurnAcks(ctx)
		require.NoError(t, err)
		assert.Equal(t, map[string]int64{"01A": writers * 25}, acks)
	})

	t.Run("rejects_invalid_rows", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()
		at := time.UnixMilli(1_700_000_000_000)

		require.Error(t, st.AckTurn(ctx, "  ", 100, at))
		require.Error(t, st.AckTurn(ctx, "01A", 0, at))
		require.Error(t, st.AckTurn(ctx, "01A", -1, at))

		acks, err := st.TurnAcks(ctx)
		require.NoError(t, err)
		assert.Empty(t, acks)
	})
}
