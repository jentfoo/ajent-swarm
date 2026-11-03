package fleet

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Exited swarm children stay listed for one-click resume: the four most
// recent pin under the alive rows, most-recent-first, and older ones age out.

func exitedRec(id string, pid int, at time.Time) ChildRecord {
	return ChildRecord{
		SessionID: id,
		PID:       pid,
		Workspace: "/w",
		ExitedAt:  at,
		ExitNote:  "exited",
	}
}

func TestSessionsKeepExitedPinned(t *testing.T) {
	m := New(Options{Log: testLogger()})
	now := time.Now()
	for _, rec := range []ChildRecord{
		exitedRec("01EXITMID0000000000", 4202, now.Add(-time.Minute)), // the newer exit
		exitedRec("01EXITOLD0000000000", 4201, now.Add(-2*time.Minute)),
	} {
		m.children[rec.PID] = &childProc{rec: rec}
	}
	live := &sessionActor{}
	live.key.sessionID = "01LIVESESSION000000"
	live.status.Store(&Status{
		SessionID: live.key.sessionID,
		State:     ChildOnline,
		SpawnedBy: SpawnedBySwarm,
	})
	m.actors[actorKey{sessionID: live.key.sessionID, token: "t"}] = live

	rows := m.Sessions()
	require.Len(t, rows, 3)
	// alive sorts before exited ones; ended rows run most-recent-first
	assert.Equal(t, "01LIVESESSION000000", rows[0].SessionID)
	assert.Equal(t, ChildOnline, rows[0].State)
	assert.Equal(t, "01EXITMID0000000000", rows[1].SessionID)
	assert.Equal(t, ChildExited, rows[1].State)
	assert.Equal(t, "01EXITOLD0000000000", rows[2].SessionID)
}

func TestSessionsCapExitedAtFour(t *testing.T) {
	m := New(Options{Log: testLogger()})
	now := time.Now()
	for i := range 6 {
		rec := exitedRec(
			string(rune('A'+i))+"-session-padding0", 4301+i, now.Add(-time.Duration(i)*time.Minute))
		m.children[rec.PID] = &childProc{rec: rec}
	}

	rows := m.Sessions()
	require.Len(t, rows, maxExitedPinned)
	// the newest four survive; the two oldest dropped off
	assert.Equal(t, "A-session-padding0", rows[0].SessionID)
	assert.Equal(t, "D-session-padding0", rows[maxExitedPinned-1].SessionID)
}

func TestSessionsHideReplacedExitedRows(t *testing.T) {
	m := New(Options{Log: testLogger()})
	now := time.Now()
	old := &childProc{rec: exitedRec("01SESSIONREUSED0000", 4401, now.Add(-time.Hour))}
	m.children[old.rec.PID] = old
	replacement := &sessionActor{}
	replacement.key.sessionID = "01SESSIONREUSED0000"
	replacement.status.Store(&Status{
		SessionID: replacement.key.sessionID,
		State:     ChildOnline,
	})
	m.actors[actorKey{sessionID: replacement.key.sessionID, token: "t"}] = replacement

	rows := m.Sessions()
	require.Len(t, rows, 1)
	assert.Equal(t, ChildOnline, rows[0].State) // the live instance owns the row
}

func TestLastBusyAtReadsActorActivity(t *testing.T) {
	t.Parallel()
	m := New(Options{Log: testLogger()})

	// an empty fleet has never been busy
	assert.True(t, m.LastBusyAt().IsZero())

	now := time.Now()
	live := &sessionActor{}
	live.key.sessionID = "01BUSYSESSION0000000"
	live.status.Store(&Status{
		SessionID:   live.key.sessionID,
		State:       ChildOnline,
		served:      true, // attached and streaming at least once
		LastTurnEnd: now.Add(-time.Minute).UnixMilli(),
	})
	m.actors[actorKey{sessionID: live.key.sessionID, token: "t"}] = live

	// a turn that ended a minute ago reads as busy
	assert.False(t, m.LastBusyAt().IsZero())

	// a long-quiet session stops counting once its turn end ages out of memory
	live.status.Store(&Status{
		SessionID:   live.key.sessionID,
		State:       ChildOnline,
		served:      true,
		LastTurnEnd: now.Add(-time.Hour).UnixMilli(),
	})
	busy := m.LastBusyAt()
	assert.False(t, busy.IsZero())
	assert.LessOrEqual(t, busy.UnixMilli(), now.Add(-time.Hour).UnixMilli())

	// an actively working session is busy right now
	live.status.Store(&Status{
		SessionID: live.key.sessionID,
		State:     ChildOnline,
		served:    true,
		Running:   true,
	})
	assert.Equal(t, time.Now().Round(time.Second), m.LastBusyAt().Round(time.Second))

	// an exited actor is never busy
	live.status.Store(&Status{
		SessionID: live.key.sessionID,
		State:     ChildExited,
		served:    true,
		Running:   true, // stale flag beside a terminal state still means ended
	})
	assert.True(t, m.LastBusyAt().IsZero())
}
