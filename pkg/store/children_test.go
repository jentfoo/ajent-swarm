package store

import (
	"database/sql"
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
			PID:         4242,
			SessionID:   "01ROUNDTRIP000001",
			SessionName: "daily",
			Workspace:   "/repo",
			Argv:        "--serve --session daily",
			LogPath:     "/state/children/4242.log",
			StartedAt:   time.Unix(1000, 0),
		})
		require.NoError(t, err)
		assert.Positive(t, id)

		rows, err := st.Children(ctx)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Equal(t, 4242, rows[0].PID)
		assert.Equal(t, "/repo", rows[0].Workspace)
		assert.Equal(t, "--serve --session daily", rows[0].Argv)
		assert.Equal(t, "daily", rows[0].SessionName)
		assert.Equal(t, OriginSwarm, rows[0].Origin) // empty origin defaults to swarm
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

	t.Run("insert_if_absent_dedupes", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()

		id, inserted, err := st.CreateChildIfAbsent(ctx, Child{
			PID:         55,
			SessionID:   "01FIRSTSEEN000001",
			SessionName: "daily",
			Workspace:   "/repo",
			StartedAt:   time.Unix(1000, 0),
			Origin:      OriginExternal,
		})
		require.NoError(t, err)
		assert.True(t, inserted)
		assert.Positive(t, id)

		// a repeated discovery pass over the same process keeps the first row
		again, inserted, err := st.CreateChildIfAbsent(ctx, Child{
			PID: 55, SessionID: "01LATERPASS000001", Origin: OriginExternal,
		})
		require.NoError(t, err)
		assert.False(t, inserted)
		assert.Equal(t, id, again)

		_, inserted, err = st.CreateChildIfAbsent(ctx, Child{PID: 56, SessionID: "01SECONDROW00001"})
		require.NoError(t, err)
		assert.True(t, inserted)

		rows, err := st.Children(ctx)
		require.NoError(t, err)
		require.Len(t, rows, 2)
		assert.Equal(t, "01FIRSTSEEN000001", rows[1].SessionID)
		assert.Equal(t, OriginExternal, rows[1].Origin)
		assert.Equal(t, OriginSwarm, rows[0].Origin) // empty origin defaults to swarm
	})

	t.Run("newest_first", func(t *testing.T) {
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

	t.Run("externals_leave_spawn_facts_null", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()

		_, inserted, err := st.CreateChildIfAbsent(ctx, Child{
			PID: 91, SessionID: "01EXTERNAL00000001", Workspace: "/repo",
			StartedAt: time.Unix(1000, 0), Origin: OriginExternal,
		})
		require.NoError(t, err)
		assert.True(t, inserted)

		var argv, logPath sql.NullString
		require.NoError(t, st.db.QueryRowContext(ctx,
			`SELECT argv, log_path FROM children WHERE pid = 91`).Scan(&argv, &logPath))
		assert.False(t, argv.Valid) // externals have neither: NULL, not empty text
		assert.False(t, logPath.Valid)
	})

	t.Run("delete_removes_one_row", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()

		id, err := st.CreateChild(ctx, Child{PID: 77, SessionID: "01GONE0000000001"})
		require.NoError(t, err)
		kept, err := st.CreateChild(ctx, Child{PID: 78, SessionID: "01KEPT0000000001"})
		require.NoError(t, err)

		require.NoError(t, st.DeleteChild(ctx, id))
		require.NoError(t, st.DeleteChild(ctx, id)) // an unknown id is already gone

		rows, err := st.Children(ctx)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Equal(t, kept, rows[0].ID)
	})
}
