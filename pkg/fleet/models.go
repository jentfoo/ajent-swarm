package fleet

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/go-analyze/bulk"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// Model discovery rides ajent's own picker: submitting bare /model opens an
// interaction.pending dialog whose option labels are the session's real model
// registry, with no protocol change and no swarm-side copy to drift. A
// first-class models listing over the control socket stays upstream (phase 12).
const (
	modelPickerLine = "/model"

	pickerWaitMax   = 2 * time.Second       // how long discovery waits for the dialog
	pickerPollEvery = 25 * time.Millisecond // reconciled-view poll cadence

	// modelRowWait bounds one session's snapshot read in the listing: the
	// state is memory behind a mailbox, so anything slower means the actor is
	// busy with an upstream call and the row just drops out of this best-effort
	// list.
	modelRowWait = 500 * time.Millisecond
)

// ModelRow is one session's model facts. Current always comes from that
// session's snapshot; Options and DialogID appear only when discovery ran,
// leaving ajent's picker open for the caller to answer or cancel via /resolve.
type ModelRow struct {
	SessionID string         `json:"sessionId"`
	Current   ctl.ModelState `json:"current"`
	Options   []string       `json:"options,omitempty"` // picker labels, index-answerable
	DialogID  uint64         `json:"dialogId,omitempty"`
}

type msgModelDiscover struct{ reply chan modelDiscovery }

// modelDiscovery answers the /model submit: the dialog ids open before it,
// so the caller can tell the picker apart from every other dialog.
type modelDiscovery struct {
	before map[uint64]struct{}
	err    error
}

// handleModelDiscover submits bare /model after the usual seat and readiness
// checks. The picker itself arrives later as an event; the caller polls for it.
func (a *sessionActor) handleModelDiscover(msg msgModelDiscover) {
	if !a.ready() {
		msg.reply <- modelDiscovery{err: notReady()}
		return
	}
	if a.view.running { // a queued /model would open its picker too late to watch
		msg.reply <- modelDiscovery{err: ctl.Errf(ctl.CodeUnavailable,
			"a turn is running; model discovery needs an idle session")}
		return
	}

	before := make(map[uint64]struct{}, len(a.view.interactions))
	for _, d := range a.view.interactions {
		before[d.ID] = struct{}{}
	}
	if err := a.ensureWriteSeat(); err != nil {
		msg.reply <- modelDiscovery{err: err}
		return
	}
	cctx, cancel := a.callWait()
	defer cancel()
	err := a.conn.Submit(cctx, ctl.SubmitParams{Line: modelPickerLine})
	msg.reply <- modelDiscovery{before: before, err: err}
}

// ModelRows lists one row per live session with the model its snapshot holds.
func (m *Manager) ModelRows(ctx context.Context) []ModelRow {
	m.mu.Lock()
	actors := bulk.MapValuesSlice(m.actors)
	m.mu.Unlock()

	out := make([]ModelRow, 0, len(actors))
	for _, a := range actors {
		st := a.status.Load()
		if st.State == ChildExited || !st.served {
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

// DiscoverModels opens ajent's own model picker for one session and returns
// its option labels beside the dialog id, leaving the dialog open so a caller
// answers it by index or cancels it through /resolve.
func (m *Manager) DiscoverModels(ctx context.Context, sessionID string) (ModelRow, error) {
	a := m.route(sessionID)
	if a == nil {
		return ModelRow{}, ErrUnknownSession
	}

	opened, err := mailboxCommand(ctx, a, func(reply chan modelDiscovery) actorMsg {
		return msgModelDiscover{reply: reply}
	})
	if err != nil {
		return ModelRow{}, err
	}
	if opened.err != nil {
		return ModelRow{}, opened.err
	}

	for deadline := time.Now().Add(pickerWaitMax); ; {
		snap, err := m.Snapshot(ctx, sessionID)
		if err != nil { // the session ended or its actor stopped under us
			return ModelRow{}, err
		}
		if row, ok := pickerRow(sessionID, snap, opened.before); ok {
			return row, nil
		}
		if time.Now().After(deadline) {
			break
		}
		if !waitTick(ctx) { // the caller gave up: close any late picker behind us
			m.cancelModelPicker(ctx, sessionID, opened.before)
			return ModelRow{}, ctx.Err()
		}
	}

	// nothing appeared: the picker may still be open from our own submit, so
	// close it before reporting discovery a failure
	m.cancelModelPicker(ctx, sessionID, opened.before)
	return ModelRow{}, ctl.Errf(ctl.CodeUnavailable, "no model picker appeared")
}

// waitTick sleeps one poll step; false means ctx ended.
func waitTick(ctx context.Context) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(pickerPollEvery):
		return true
	}
}

// pickerRow builds the discovery answer once a dialog ajent opened for /model
// shows up in the reconciled view. New means absent before the submit.
func pickerRow(sessionID string, snap ctl.State, before map[uint64]struct{}) (ModelRow, bool) {
	for _, d := range snap.Interactions {
		if _, seen := before[d.ID]; seen {
			continue
		}
		return ModelRow{
			SessionID: sessionID,
			Current:   snap.Model,
			Options:   d.Options,
			DialogID:  d.ID,
		}, true
	}
	return ModelRow{}, false
}

// cancelModelPicker cancels the dialog ajent opened for discovery, best
// effort, so a given-up call never strands the session on an open picker.
func (m *Manager) cancelModelPicker(ctx context.Context, sessionID string, before map[uint64]struct{}) {
	ctx = context.WithoutCancel(ctx) // a canceled caller still needs its picker closed
	snap, err := m.Snapshot(ctx, sessionID)
	if err != nil {
		return
	}
	row, ok := pickerRow(sessionID, snap, before)
	if !ok || row.DialogID == 0 {
		return
	}
	_ = m.Resolve(ctx, sessionID, ctl.ResolveParams{ID: row.DialogID, Cancel: true})
}
