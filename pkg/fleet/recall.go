package fleet

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"time"

	"github.com/go-analyze/bulk"
	"github.com/jentfoo/ajent/pkg/command"
	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/session"
)

// Workspace-wide recall: the composer's Ctrl+R serves what an interactive CLI
// in that workspace recalls, read from ajent's own store through its exported
// session package (editor history plus recorded transcript prompts), merged
// with swarm's mirror of every typed prompt its own send path submitted.
// Scheduler launches never record to the mirror, since their runs already
// persist prompts in the runs table.

// recallSecretPrefix is upstream's pasted-secret marker (pkg/app/driver's
// secretPrefix, unexported there). Testing through upstream's HasSecretPrefix
// keeps swarm's classification identical to ajent's own editor-history rule.
const recallSecretPrefix = "secret:"

// maxRecallPending bounds the submit ledger awaiting its committed entry, an
// evicted submit simply keeps its recorded text.
const maxRecallPending = 256

// RecallLine is one row of the workspace recall listing served to clients: a
// submitted typed prompt with its record time, newest first. Mirror rows carry
// their store id, ajent-store rows read zero. Withheld rows (an empty text)
// never surface through a listing.
type RecallLine struct {
	ID        int64     `json:"id"`
	Text      string    `json:"text"`
	CreatedAt time.Time `json:"createdAt"`
}

// RecallStore persists the workspace recall mirror of typed submits. A nil
// store disables recording, and listings then serve ajent's own sources alone.
type RecallStore interface {
	RecordRecallLine(ctx context.Context, workspace, text string, at time.Time) (int64, error)
	ScrubRecallLine(ctx context.Context, id int64) error
	RecallLines(ctx context.Context, workspace, query string, limit int) ([]RecallLine, error)
}

// recallMirrorPage bounds one mirror read: the table keeps at most this many
// rows per workspace, so a full page cannot truncate a candidate the merged
// listing would still rank.
const recallMirrorPage = 1000

// RecallLines serves a session workspace's recall listing: what an interactive
// CLI recalls there (ajent's editor history merged with its recorded transcript
// prompts) beside swarm's own tracked submits, one row per distinct text at its
// newest record time, newest first. Query narrows by case-insensitive
// substring. Both the ajent read and a failed mirror read are best effort:
// whatever was readable is what serves. An unknown session refuses.
func (m *Manager) RecallLines(ctx context.Context, sessionID, query string, limit int) ([]RecallLine, error) {
	a := m.route(sessionID)
	if a == nil {
		return nil, ErrUnknownSession
	}
	ws := a.status.Load().Workspace
	if ws == "" {
		return []RecallLine{}, nil
	}

	out := mergeRecallLines(m.mirrorRecallLines(ctx, ws), m.ajentRecallLines(ws))
	q := strings.ToLower(query)
	out = bulk.SliceFilterInPlace(func(r RecallLine) bool {
		return strings.Contains(strings.ToLower(r.Text), q)
	}, out)
	slices.SortStableFunc(out, func(a, b RecallLine) int { return b.CreatedAt.Compare(a.CreatedAt) })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// mirrorRecallLines reads the recall mirror's page for workspace. A read
// failure logs and serves nothing, recall staying best effort everywhere.
func (m *Manager) mirrorRecallLines(ctx context.Context, ws string) []RecallLine {
	if m.recallStore == nil {
		return nil
	}
	wctx, cancel := context.WithTimeout(ctx, storeWriteWait)
	defer cancel()
	rows, err := m.recallStore.RecallLines(wctx, ws, "", recallMirrorPage)
	if err != nil {
		m.log.Warn("recall mirror not read", "workspace", ws, "err", err)
		return nil
	}
	return rows
}

// ajentRecallLines reads the workspace's recall candidates from ajent's own
// store: typed editor-history lines first with their recorded prompt times,
// transcript prompts backfilling what never reached the line file, exactly
// what an interactive CLI recalls there. Secret discipline and slash-command
// hiding are upstream's own rules. A text found only in editor history keeps
// a zero time.
func (m *Manager) ajentRecallLines(ws string) []RecallLine {
	store, err := session.NewStore()
	if err != nil {
		m.log.Warn("ajent session store not opened", "workspace", ws, "err", err)
		return nil
	}
	hist, err := session.NewEditorHistory(store, ws, recallSecretPrefix)
	if err != nil {
		m.log.Warn("editor history not read", "workspace", ws, "err", err)
		return nil
	}
	lines := session.NewRecallIndex(store, ws, recallSecretPrefix, hist).Lines()
	out := make([]RecallLine, len(lines))
	for i, p := range lines {
		out[i] = RecallLine{Text: p.Text, CreatedAt: p.At}
	}
	return out
}

// mergeRecallLines folds both sources into one row per text at its newest
// record time. Earlier entries keep their slot, so a mirror id survives a tie
// and the order stays deterministic ahead of the listing's sort.
func mergeRecallLines(mirror, ajent []RecallLine) []RecallLine {
	out := make([]RecallLine, 0, len(mirror)+len(ajent))
	seen := make(map[string]int, cap(out)) // text → slot in out
	add := func(r RecallLine) {
		if r.Text == "" {
			return
		}
		if i, ok := seen[r.Text]; ok {
			if r.CreatedAt.After(out[i].CreatedAt) {
				out[i] = r
			}
			return
		}
		seen[r.Text] = len(out)
		out = append(out, r)
	}
	for _, r := range mirror {
		add(r)
	}
	for _, r := range ajent {
		add(r)
	}
	return out
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
// redaction, so they resolve nothing here, dropped prompts stay recallable.
func (a *sessionActor) recallObserve(ev ctl.Event) {
	if len(a.recallIDs) == 0 {
		return
	}
	switch ev.Name {
	case ctl.EventQueued: // full replacement, only this family redacts texts
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
// entry withhold, a normal commit settles them with their recorded text.
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
