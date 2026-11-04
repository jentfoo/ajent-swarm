package store

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestChildren(t *testing.T) {
	t.Parallel()

	t.Run("roundtrip", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()

		id, err := st.CreateChild(ctx, Child{
			PID:       4242,
			Workspace: "/repo",
			Argv:      "--serve --session daily",
			LogPath:   "/state/children/4242.log",
			StartedAt: time.Unix(1000, 0),
		})
		require.NoError(t, err)
		assert.Positive(t, id)

		rows, err := st.Children(ctx)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Equal(t, 4242, rows[0].PID)
		assert.Equal(t, "/repo", rows[0].Workspace)
		assert.Equal(t, "--serve --session daily", rows[0].Argv)
		assert.Nil(t, rows[0].ExitCode)
		assert.True(t, rows[0].ExitedAt.IsZero())

		code := -1
		exited := time.Unix(2000, 0)
		rows[0].SessionID = "01SESS"
		rows[0].LogPath = "/state/children/01SESS-4242.log"
		rows[0].ExitedAt = exited
		rows[0].ExitCode = &code
		rows[0].ExitNote = "signal: killed"
		rows[0].LogTail = "ajent: no model configured"
		require.NoError(t, st.UpdateChild(ctx, rows[0]))

		rows, err = st.Children(ctx)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Equal(t, "01SESS", rows[0].SessionID)
		assert.Equal(t, exited, rows[0].ExitedAt)
		require.NotNil(t, rows[0].ExitCode)
		assert.Equal(t, -1, *rows[0].ExitCode)
		assert.Equal(t, "signal: killed", rows[0].ExitNote)
		assert.Equal(t, "ajent: no model configured", rows[0].LogTail)
	})

	t.Run("newest first", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()

		for _, pid := range []int{11, 22, 33} {
			_, err := st.CreateChild(ctx, Child{PID: pid, StartedAt: time.Unix(1000, 0)})
			require.NoError(t, err)
		}

		rows, err := st.Children(ctx)
		require.NoError(t, err)
		require.Len(t, rows, 3)
		assert.Equal(t, 33, rows[0].PID)
		assert.Equal(t, 22, rows[1].PID)
		assert.Equal(t, 11, rows[2].PID)
	})
}
