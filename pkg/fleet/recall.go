package fleet

import (
	"context"
	"encoding/json"
	"time"

	"github.com/go-analyze/bulk"
	"github.com/jentfoo/ajent/pkg/command"
	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/session"
)

// Workspace-wide recall: swarm mirrors every typed prompt its own send path
// submitted into a per-workspace store, so the web composer recalls across
// sessions the way ajent's Ctrl+R does. Scheduler launches never record here,
// since their runs already persist prompts in the runs table.

// recallSecretPrefix is upstream's pasted-secret marker (pkg/app/driver's
// secretPrefix, unexported there). Testing through upstream's HasSecretPrefix
// keeps swarm's classification identical to ajent's own editor-history rule.
const recallSecretPrefix = "secret:"

// maxRecallPending bounds the submit ledger awaiting its committed entry; an
// evicted submit simply keeps its recorded text.
const maxRecallPending = 256

// RecallLine is one row of the workspace recall mirror served to clients: a
// submitted typed prompt with its record time, newest first. Withheld rows
// (an empty text) never surface through a listing.
type RecallLine struct {
	ID        int64     `json:"id"`
	Text      string    `json:"text"`
	CreatedAt time.Time `json:"createdAt"`
}

// RecallStore persists the workspace recall mirror. A nil store disables
// recording and every listing reads empty.
type RecallStore interface {
	RecordRecallLine(ctx context.Context, workspace, text string, at time.Time) (int64, error)
	ScrubRecallLine(ctx context.Context, id int64) error
	RecallLines(ctx context.Context, workspace, query string, limit int) ([]RecallLine, error)
}

// RecallLines serves a session's workspace recall mirror: the typed prompts
// submitted through swarm there, newest first, query narrowing by
// case-insensitive substring. No store configured reads empty; an unknown
// session refuses.
func (m *Manager) RecallLines(ctx context.Context, sessionID, query string, limit int) ([]RecallLine, error) {
	a := m.route(sessionID)
	if a == nil {
		return nil, ErrUnknownSession
	}
	ws := a.status.Load().Workspace
	if m.recallStore == nil || ws == "" {
		return []RecallLine{}, nil
	}
	wctx, cancel := context.WithTimeout(ctx, storeWriteWait)
	defer cancel()
	return m.recallStore.RecallLines(wctx, ws, query, limit)
}

// recordRecallSubmit mirrors one accepted submit into the workspace recall
// store, the tracked send path only: typed prompts record, slash and shell
// lines never do, and a secret-prefixed line records withheld. The row id
// waits in the ledger for the committed entry's classification. Runs on the
// actor goroutine, after the submit reply, so recall never gates the send.
func (a *sessionActor) recordRecallSubmit(params ctl.SubmitParams) {
	if a.mgr.recallStore == nil || a.view.workspace == "" {
		return
	}
	line := command.ParseLine(params.Line)
	if line.Kind != command.KindPrompt { // slash commands and shell runs never recall
		return
	}
	text := params.Line // verbatim, escape spaces included, like upstream's store
	if session.HasSecretPrefix(recallSecretPrefix, line.Rest) {
		text = "" // withheld: an empty-text row keeps the id resolvable
	}
	wctx, cancel := context.WithTimeout(a.mgr.storeCtx, storeWriteWait)
	defer cancel()
	id, err := a.mgr.recallStore.RecordRecallLine(wctx, a.view.workspace, text, time.Now())
	if err != nil {
		a.log.Warn("prompt not recorded for recall", "err", err)
		return
	}
	if text != "" && params.PendingID != "" {
		a.recallTrack(params.PendingID, id)
	}
}

// recallObserve watches one applied upstream event for facts a tracked submit
// waits on: the committed entry's classification, and a wire-redacted queue
// row whose text upstream withheld. Queue drops mean absence of commit, never
// redaction, so they resolve nothing here; dropped prompts stay recallable.
func (a *sessionActor) recallObserve(ev ctl.Event) {
	if len(a.recallIDs) == 0 {
		return
	}
	switch ev.Name {
	case ctl.EventQueued: // full replacement; only this family redacts texts
		var d ctl.QueuedData
		if err := ev.Decode(&d); err != nil {
			return
		}
		for _, row := range d.Rows {
			if row.Text == "" {
				a.recallDropWait(row.ID)
			}
		}
	case ctl.EventEntryAppend:
		var d ctl.EntryData
		if err := ev.Decode(&d); err != nil || d.Entry.ID == "" {
			return
		}
		a.recallCommitEntry(d.Entry)
	}
}

// recallCommitEntry resolves the tracked submits one committed message names.
// A typed prompt never commits injected upstream, so members of an injected
// entry withhold; a normal commit settles them with their recorded text.
func (a *sessionActor) recallCommitEntry(e ctl.Entry) {
	if e.Type != string(session.TypeMessage) || len(e.Data) == 0 {
		return
	}
	var md session.MessageData
	if json.Unmarshal(e.Data, &md) != nil {
		return
	}
	for _, pendingID := range md.QueueIDs {
		row, ok := a.recallIDs[pendingID]
		if !ok {
			continue
		}
		delete(a.recallIDs, pendingID)
		if md.Injected {
			a.recallWithhold(row)
		}
	}
}

// recallBackfill resolves ledger waits a reconnect's backfill already answers:
// snapshot queue rows redact secrets to empty text, and the branch carries
// any commit the drop overran.
func (a *sessionActor) recallBackfill(snap ctl.State, branch []session.Entry) {
	if len(a.recallIDs) == 0 {
		return
	}
	for _, row := range snap.QueuedRows {
		if row.Text == "" {
			a.recallDropWait(row.ID)
		}
	}
	for _, e := range branch {
		a.recallCommitEntry(wireEntry(e))
	}
}

// recallTrack remembers one recorded submit's row until its committed entry
// resolves it, bounded so prompts that never land cannot grow the ledger.
func (a *sessionActor) recallTrack(pendingID string, row int64) {
	a.recallIDs[pendingID] = row
	a.recallOrder = append(a.recallOrder, pendingID)
	for len(a.recallIDs) > maxRecallPending && len(a.recallOrder) > 0 {
		oldest := a.recallOrder[0]
		a.recallOrder = a.recallOrder[1:]
		delete(a.recallIDs, oldest)
	}
	if len(a.recallOrder) > 4*maxRecallPending { // dead ids off the front only
		a.recallOrder = bulk.MapKeysSlice(a.recallIDs)
	}
}

// recallDropWait withholds the row a pending submit waits behind, when the
// ledger still tracks it.
func (a *sessionActor) recallDropWait(pendingID string) {
	row, ok := a.recallIDs[pendingID]
	if !ok {
		return
	}
	delete(a.recallIDs, pendingID)
	a.recallWithhold(row)
}

// recallWithhold scrubs one recorded row's text, best effort: the row keeps
// its id so references resolve, recall just never offers the content. A row
// the cap already pruned scrubs as nothing.
func (a *sessionActor) recallWithhold(row int64) {
	wctx, cancel := context.WithTimeout(a.mgr.storeCtx, storeWriteWait)
	defer cancel()
	if err := a.mgr.recallStore.ScrubRecallLine(wctx, row); err != nil {
		a.log.Warn("recall row not withheld", "row", row, "err", err)
	}
}
