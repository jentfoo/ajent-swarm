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
		db := openBeforeVersion(t, path, 8)
		ctx := t.Context()

		_, err := db.ExecContext(ctx, `INSERT INTO children
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
		path := filepath.Join(t.TempDir(), FileName)
		db := openBeforeVersion(t, path, 7)
		ctx := t.Context()
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

	t.Run("queued_column_upgrade", func(t *testing.T) {
		// upgrades a database built by every migration before the queued flag,
		// so pre-existing rows default off while a fresh row round trips
		path := filepath.Join(t.TempDir(), FileName)
		db := openBeforeVersion(t, path, 9)
		ctx := t.Context()
		require.NoError(t, db.Close())

		st, err := Open(path) // applies the queued migration over the database
		require.NoError(t, err)
		t.Cleanup(func() { _ = st.Close() })

		_, err = st.db.ExecContext(ctx, `INSERT INTO jobs
	        (name, workspace, prompt, spawn_mode, schedule_kind, interval_seconds,
	         on_missed, overlap, created_at)
	        VALUES ('legacy', '/repo', 'go', 'new', 'interval', 60, 'skip', 'run', 0)`)
		require.NoError(t, err)

		slot := time.Unix(5000, 0)
		id, err := st.CreateJob(ctx, Job{Name: "queued", Workspace: "/repo",
			ScheduleKind: ScheduleOnce, NextRunAt: &slot, OnMissed: MissSkip,
			Overlap: OverlapRun, Queued: true, CreatedAt: time.Unix(1000, 0)})
		require.NoError(t, err)
		_, err = st.JobByID(ctx, id)
		require.NoError(t, err)

		jobs, err := st.Jobs(ctx)
		require.NoError(t, err)
		require.Len(t, jobs, 2)
		for _, j := range jobs {
			if j.Name == "legacy" {
				assert.False(t, j.Queued)
			} else {
				assert.True(t, j.Queued)
			}
		}
	})

	t.Run("attention_acks_upgrade", func(t *testing.T) {
		// upgrades a database built by every migration before the attention
		// tables, so the new schema lands over existing state and acks round-trip
		path := filepath.Join(t.TempDir(), FileName)
		db := openBeforeVersion(t, path, 11)
		require.NoError(t, db.Close())

		st, err := Open(path) // applies the attention migration over the database
		require.NoError(t, err)
		t.Cleanup(func() { _ = st.Close() })

		ctx := t.Context()
		at := time.Unix(1_700_000_000, 0)
		require.NoError(t, st.AckDialog(ctx, "01ACKED0000000000", 5, 9, at))
		require.NoError(t, st.AckTurn(ctx, "01ACKED0000000000", at.UnixMilli(), at))

		acks, err := st.DialogAcks(ctx)
		require.NoError(t, err)
		assert.Equal(t, []DialogAck{{SessionID: "01ACKED0000000000", PID: 5, DialogID: 9,
			AckedAt: at.UnixMilli()}}, acks)
		turns, err := st.TurnAcks(ctx)
		require.NoError(t, err)
		assert.Equal(t, map[string]int64{"01ACKED0000000000": at.UnixMilli()}, turns)
	})
}

// openBeforeVersion replays every migration below want onto a fresh database,
// recording versions the way Open would, the caller closes the handle so Open
// applies the remaining migrations as a real upgrade.
func openBeforeVersion(t *testing.T, path string, want int) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	require.NoError(t, err)
	ctx := t.Context()
	_, err = db.ExecContext(ctx, `CREATE TABLE schema_migrations (
	    version INTEGER PRIMARY KEY,
	    applied_at INTEGER NOT NULL)`)
	require.NoError(t, err)
	for _, m := range readMigrations() {
		if m.version >= want {
			continue
		}
		_, err = db.ExecContext(ctx, m.sql)
		require.NoError(t, err)
		_, err = db.ExecContext(ctx,
			`INSERT INTO schema_migrations (version, applied_at) VALUES (?, 0)`, m.version)
		require.NoError(t, err)
	}
	return db
}
