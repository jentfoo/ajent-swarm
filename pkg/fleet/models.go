package fleet

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/go-analyze/bulk"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// modelRowWait bounds one session's snapshot read in the listing: the state
// is memory behind a mailbox, so anything slower means the actor is busy with
// an upstream call and the row just drops out of this best-effort list.
const modelRowWait = 500 * time.Millisecond

// ModelRow is one session's model facts. Current always comes from that
// session's snapshot; switching happens through ModelSet against the same
// registry models.get lists, with no picker dialog to ride.
type ModelRow struct {
	SessionID string         `json:"sessionId"`
	Current   ctl.ModelState `json:"current"`
}

// ModelRows lists one row per live session with the model its snapshot holds.
func (m *Manager) ModelRows(ctx context.Context) []ModelRow {
	m.mu.Lock()
	actors := bulk.MapValuesSlice(m.actors)
	m.mu.Unlock()

	out := make([]ModelRow, 0, len(actors))
	for _, a := range actors {
		st := a.status.Load()
		if !st.serving() {
			continue
		}
		rctx, cancel := context.WithTimeout(ctx, modelRowWait)
		state, err := m.Snapshot(rctx, st.SessionID)
		cancel()
		if err != nil { // an actor mid-teardown just drops out
			continue
		}
		out = append(out, ModelRow{SessionID: st.SessionID, Current: state.Model})
	}
	slices.SortFunc(out, func(a, b ModelRow) int { return strings.Compare(a.SessionID, b.SessionID) })
	return out
}

// ModelOptions unions every live session's model registry into one sorted
// key list: the choices a swarm-level picker (the titling model) offers. A
// session that will not answer just drops out of the union.
func (m *Manager) ModelOptions(ctx context.Context) []ctl.ModelState {
	m.mu.Lock()
	actors := bulk.MapValuesSlice(m.actors)
	m.mu.Unlock()

	byKey := make(map[string]ctl.ModelState)
	for _, a := range actors {
		st := a.status.Load()
		if !st.serving() {
			continue
		}
		rctx, cancel := context.WithTimeout(ctx, modelRowWait)
		listing, err := m.Models(rctx, st.SessionID)
		cancel()
		if err != nil { // an actor mid-teardown just drops out
			continue
		}
		for _, row := range listing.Models {
			byKey[row.Key] = row
		}
	}
	out := bulk.MapValuesSlice(byKey)
	slices.SortFunc(out, func(a, b ctl.ModelState) int { return strings.Compare(a.Key, b.Key) })
	return out
}
