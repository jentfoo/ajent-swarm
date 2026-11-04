package store

import (
	"database/sql"
	"path/filepath"
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

	t.Run("insert if absent dedupes", func(t *testing.T) {
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

func TestChildOriginMigration(t *testing.T) {
	t.Parallel()

	t.Run("legacy rows read as swarm", func(t *testing.T) {
		t.Parallel()

		path := filepath.Join(t.TempDir(), FileName)
		db, err := sql.Open("sqlite", "file:"+path)
		require.NoError(t, err)
		ctx := t.Context()

		// replay every migration before the origin column, so Open migrates a
		// real pre-0008 database
		_, err = db.ExecContext(ctx, `CREATE TABLE schema_migrations (
		    version INTEGER PRIMARY KEY,
		    applied_at INTEGER NOT NULL)`)
		require.NoError(t, err)
		for _, m := range readMigrations() {
			if m.version >= 8 {
				continue
			}
			_, err = db.ExecContext(ctx, m.sql)
			require.NoError(t, err)
			_, err = db.ExecContext(ctx,
				`INSERT INTO schema_migrations (version, applied_at) VALUES (?, 0)`, m.version)
			require.NoError(t, err)
		}
		_, err = db.ExecContext(ctx, `INSERT INTO children
		    (pid, session_id, workspace, argv, log_path, started_at)
		    VALUES (77, '01LEGACY0000000001', '/repo', '--serve', '/logs/77.log', 1000)`)
		require.NoError(t, err)
		require.NoError(t, db.Close())

		st, err := Open(path)
		require.NoError(t, err)
		t.Cleanup(func() { _ = st.Close() })

		rows, err := st.Children(ctx)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Equal(t, OriginSwarm, rows[0].Origin)
		assert.Equal(t, "--serve", rows[0].Argv) // spawn facts survive the rebuild
		assert.Equal(t, "/logs/77.log", rows[0].LogPath)
	})

	t.Run("externals leave spawn facts null", func(t *testing.T) {
		t.Parallel()

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
}
