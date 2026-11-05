package store

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMigrate(t *testing.T) {
	t.Parallel()

	t.Run("child_origin_upgrade", func(t *testing.T) {
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

	t.Run("tools_columns_upgrade", func(t *testing.T) {
		// upgrades a database built by every migration before job_tools, so the
		// new columns default cleanly for pre-existing rows while round-tripping
		// through create and read
		path := t.TempDir() + "/" + FileName

		// replay every migration except job_tools onto a fresh file, recording
		// versions the way Open would, so the upgrade path runs for real
		db, err := sql.Open("sqlite", "file:"+path)
		require.NoError(t, err)
		ctx := t.Context()
		_, err = db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
	    version INTEGER PRIMARY KEY,
	    applied_at INTEGER NOT NULL)`)
		require.NoError(t, err)
		for _, m := range readMigrations() {
			if m.version >= 7 {
				continue
			}
			_, err = db.ExecContext(ctx, m.sql)
			require.NoError(t, err)
			_, err = db.ExecContext(ctx,
				`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
				m.version, time.Now().Unix())
			require.NoError(t, err)
		}
		require.NoError(t, db.Close())

		st, err := Open(path) // applies the new migration over the existing database
		require.NoError(t, err)
		t.Cleanup(func() { _ = st.Close() })

		// a row written before the columns existed reads back on session defaults
		_, err = st.db.ExecContext(ctx, `INSERT INTO jobs
	        (name, workspace, prompt, spawn_mode, schedule_kind, interval_seconds,
	         on_missed, overlap, created_at)
	        VALUES ('legacy', '/repo', 'go', 'new', 'interval', 60, 'skip', 'run', 0)`)
		require.NoError(t, err)

		jobs, err := st.Jobs(ctx)
		require.NoError(t, err)
		require.Len(t, jobs, 1)
		assert.False(t, jobs[0].ToolsCustom)
		assert.Empty(t, jobs[0].Tools)

		// and the new columns carry a create/read cycle on the upgraded database
		id, err := st.CreateJob(ctx, Job{Name: "custom", Workspace: "/repo",
			ScheduleKind: ScheduleInterval, IntervalSeconds: 60, OnMissed: MissSkip,
			Overlap: OverlapRun, Tools: "builtin:read", ToolsCustom: true,
			CreatedAt: time.Unix(1000, 0)})
		require.NoError(t, err)
		got, err := st.JobByID(ctx, id)
		require.NoError(t, err)
		assert.Equal(t, "builtin:read", got.Tools)
		assert.True(t, got.ToolsCustom)
	})
}
