package app

import (
	"context"
	"errors"
	"time"

	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	"github.com/jentfoo/ajent-swarm/pkg/store"
)

// childStore adapts the SQLite store to fleet's ChildStore interface, so
// neither package carries the other's types.
type childStore struct{ st *store.Store }

func (a childStore) CreateChild(ctx context.Context, rec fleet.ChildRecord) (int64, error) {
	return a.st.CreateChild(ctx, childRow(rec))
}

func (a childStore) CreateChildIfAbsent(ctx context.Context, rec fleet.ChildRecord) (int64, bool, error) {
	return a.st.CreateChildIfAbsent(ctx, childRow(rec))
}

func (a childStore) UpdateChild(ctx context.Context, rec fleet.ChildRecord) error {
	return a.st.UpdateChild(ctx, childRow(rec))
}

func (a childStore) DeleteChild(ctx context.Context, id int64) error {
	return a.st.DeleteChild(ctx, id)
}

// childRow maps fleet's record onto the store row: identity, origin and
// spawn facts ride the insert, exit facts the update.
func childRow(rec fleet.ChildRecord) store.Child {
	return store.Child{
		ID:          rec.ID,
		PID:         rec.PID,
		SessionID:   rec.SessionID,
		SessionName: rec.SessionName,
		Workspace:   rec.Workspace,
		Argv:        rec.Argv,
		LogPath:     rec.LogPath,
		StartedAt:   rec.StartedAt,
		ExitedAt:    rec.ExitedAt,
		ExitCode:    rec.ExitCode,
		ExitNote:    rec.ExitNote,
		LogTail:     rec.LogTail,
		Origin:      rec.Origin,
	}
}

func (a childStore) Children(ctx context.Context) ([]fleet.ChildRecord, error) {
	rows, err := a.st.Children(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]fleet.ChildRecord, 0, len(rows))
	for _, ch := range rows {
		out = append(out, fleet.ChildRecord{
			ID:          ch.ID,
			PID:         ch.PID,
			SessionID:   ch.SessionID,
			SessionName: ch.SessionName,
			Workspace:   ch.Workspace,
			Argv:        ch.Argv,
			LogPath:     ch.LogPath,
			StartedAt:   ch.StartedAt,
			ExitedAt:    ch.ExitedAt,
			ExitCode:    ch.ExitCode,
			ExitNote:    ch.ExitNote,
			LogTail:     ch.LogTail,
			Origin:      ch.Origin,
		})
	}
	return out, nil
}

// titleStore adapts the SQLite store to fleet's TitleStore interface.
type titleStore struct{ st *store.Store }

func (a titleStore) SetSessionTitle(ctx context.Context, sessionID, title string) error {
	return a.st.SetSessionTitle(ctx, sessionID, title)
}

func (a titleStore) SessionTitles(ctx context.Context) (map[string]string, error) {
	return a.st.SessionTitles(ctx)
}

// settingsStore adapts the SQLite store to fleet's SettingsStore interface.
type settingsStore struct{ st *store.Store }

func (a settingsStore) Setting(ctx context.Context, key string) (string, error) {
	return a.st.Setting(ctx, key)
}

func (a settingsStore) SetSetting(ctx context.Context, key, value string) error {
	return a.st.SetSetting(ctx, key, value)
}

// recallStore adapts the SQLite store to fleet's RecallStore interface.
type recallStore struct{ st *store.Store }

func (a recallStore) RecordRecallLine(ctx context.Context,
	workspace, text string, at time.Time,
) (int64, error) {
	return a.st.RecordRecallLine(ctx, workspace, text, at)
}

func (a recallStore) ScrubRecallLine(ctx context.Context, id int64) error {
	err := a.st.ScrubRecallLine(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return nil // the cap already pruned the row; nothing to withhold
	}
	return err
}

func (a recallStore) RecallLines(ctx context.Context,
	workspace, query string, limit int,
) ([]fleet.RecallLine, error) {
	rows, err := a.st.RecallLines(ctx, workspace, query, limit)
	if err != nil {
		return nil, err
	}
	out := make([]fleet.RecallLine, len(rows))
	for i, r := range rows {
		out[i] = fleet.RecallLine{ID: r.ID, Text: r.Text, CreatedAt: r.CreatedAt}
	}
	return out, nil
}
