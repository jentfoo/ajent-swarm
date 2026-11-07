package fleet

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"
	"time"

	"github.com/go-analyze/bulk"
	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/llm"
	"github.com/jentfoo/ajent/pkg/session"
)

// Bounds on what the actor retains and what an init carries. Retention is
// generous; init tails are deliberately small so a subscribe stays cheap.
const (
	maxRetainedEntries = 8192
	maxRetainedBytes   = 64 << 20 // entry payloads held in memory per session

	initMaxEntries = 400
	initMaxBytes   = 2 << 20 // before base64 image bodies are deferred

	pageMaxEntries = 500
)

// view is the reconciled state of one ajent instance: snapshot fields kept
// current by the watermark machine, plus the committed entries. Owned by one
// actor goroutine; no locks.
type view struct {
	seq uint64 // last applied event number, everything at or below is dropped

	session    ctl.Session
	workspace  string
	cwd        string
	head       string
	model      ctl.ModelState
	permission string
	tools      []ctl.ToolState
	usage      ctl.UsageState
	context    ctl.ContextData
	running    bool
	idle       bool
	spinning   bool

	queuedRows []ctl.QueueRow
	activity   map[string]ctl.ActivityRow
	segments   map[string]ctl.Segment
	seat       ctl.SeatState

	interactions []ctl.InteractionPendingData // open dialogs, oldest first
	dialogSeen   map[uint64]int64             // dialog id to when swarm first saw it open

	lastTurnEnd int64  // unix milliseconds, 0 when no turn ended yet
	lastStop    string // stop reason the last turn ended with
	lastStopErr string // transport or context failure that ended it

	firstPrompt string // the session's first typed user prompt, for auto-naming

	entries    []entryRecord // committed entries in arrival order, oldest first
	seen       map[string]struct{}
	entryBytes int
}

// entryRecord pairs one retained entry with its approximate encoded size.
type entryRecord struct {
	e    ctl.Entry
	size int
}

// buildView seeds a fresh view from backfill: the snapshot and the transcript
// branch through its head, taken under the same watermark. Live events past
// the watermark apply on top; overlap dedupes by entry id alone.
func buildView(snap ctl.State, branch []session.Entry, watermark uint64) *view {
	v := &view{
		seq:        watermark,
		session:    snap.Session,
		workspace:  snap.Workspace,
		cwd:        snap.Cwd,
		head:       snap.Head,
		model:      snap.Model,
		permission: snap.Permission,
		usage:      snap.Usage,
		context:    snap.Context,
		running:    snap.Running,
		idle:       snap.Idle,
		spinning:   snap.Spinning,
		seat:       snap.Seat,
		seen:       make(map[string]struct{}, len(branch)),
	}
	v.tools = cloneTools(snap.Tools)
	v.queuedRows = slices.Clone(snap.QueuedRows)
	v.activity = make(map[string]ctl.ActivityRow, len(snap.Activity))
	for _, row := range snap.Activity {
		v.activity[row.Key] = row
	}
	v.segments = make(map[string]ctl.Segment, len(snap.Status.Segments))
	for _, seg := range snap.Status.Segments {
		v.segments[seg.Key] = seg
	}
	v.interactions = slices.Clone(snap.Interactions)
	if v.interactions == nil {
		v.interactions = []ctl.InteractionPendingData{}
	}
	v.dialogSeen = make(map[uint64]int64, len(v.interactions))
	for _, dlg := range v.interactions { // reattach: now is the best swarm knows
		v.dialogSeen[dlg.ID] = time.Now().UnixMilli()
	}

	for _, e := range branch {
		we := wireEntry(e)
		v.appendEntry(we)
		if v.firstPrompt == "" {
			v.firstPrompt = firstUserPrompt(we) // resumed sessions name too
		}
	}
	return v
}

// wireEntry converts a transcript entry to its wire shape.
func wireEntry(e session.Entry) ctl.Entry {
	return ctl.Entry{ID: e.ID, ParentID: e.ParentID, Type: string(e.Type), TS: e.TS, Data: e.Data}
}

// apply runs the watermark machine over one upstream event: events at or
// below the last applied seq drop, everything above updates the view. The
// caller forwards every event it applies to subscribers verbatim.
func (v *view) apply(ev ctl.Event) {
	if ev.Seq <= v.seq {
		return
	}
	v.seq = ev.Seq
	switch ev.Name {
	case ctl.EventEntryAppend:
		var d ctl.EntryData
		if err := ev.Decode(&d); err != nil || d.Entry.ID == "" {
			return
		}
		v.appendEntry(d.Entry)
		if v.firstPrompt == "" {
			v.firstPrompt = firstUserPrompt(d.Entry)
		}

	case ctl.EventBranchChanged: // committed family, the head's other event
		var d ctl.BranchChangedData
		if err := ev.Decode(&d); err != nil || d.Head == "" {
			return
		}
		v.head = d.Head

	case ctl.EventStatus:
		v.applyStatus(ev)

	case ctl.EventActivity:
		var row ctl.ActivityRow
		if err := ev.Decode(&row); err != nil || row.Key == "" {
			return
		}
		if row.Text == "" {
			delete(v.activity, row.Key)
		} else {
			v.activity[row.Key] = row
		}

	case ctl.EventTools:
		var d ctl.ToolsData
		if err := ev.Decode(&d); err != nil {
			return
		}
		v.tools = cloneTools(d.Rows)

	case ctl.EventQueued: // full replacement, oldest first
		var d ctl.QueuedData
		if err := ev.Decode(&d); err != nil {
			return
		}
		v.queuedRows = d.Rows

	case ctl.EventQueueDropped: // names rows a removal cleared; resolve by id
		var d ctl.QueueDroppedData
		if err := ev.Decode(&d); err != nil || len(d.Rows) == 0 {
			return
		}
		dropped := make(map[string]struct{}, len(d.Rows))
		for _, row := range d.Rows {
			dropped[row.ID] = struct{}{}
		}
		v.queuedRows = slices.DeleteFunc(v.queuedRows, func(row ctl.QueueRow) bool {
			_, hit := dropped[row.ID]
			return hit
		})

	case ctl.EventPermission:
		var d ctl.PermissionData
		if err := ev.Decode(&d); err == nil {
			v.permission = d.Mode
		}

	case ctl.EventContext:
		var d ctl.ContextData
		if err := ev.Decode(&d); err == nil {
			v.context = d
		}

	case ctl.EventIdle:
		var d ctl.IdleData
		if err := ev.Decode(&d); err == nil {
			v.idle = d.Idle
		}

	case ctl.EventTurnStart:
		v.running = true

	case ctl.EventTurnEnd:
		var d ctl.TurnEndData
		if err := ev.Decode(&d); err == nil {
			v.lastStop = d.Stop
			v.lastStopErr = d.Err
		}
		v.running = false
		v.lastTurnEnd = time.Now().UnixMilli()

	case ctl.EventSessionRenamed:
		var d ctl.SessionRenamedData
		if err := ev.Decode(&d); err == nil && d.Name != "" {
			v.session.Name = d.Name
		}

	case ctl.EventInteractionPending:
		var d ctl.InteractionPendingData
		if err := ev.Decode(&d); err != nil || d.ID == 0 {
			return
		}
		v.pendingInteraction(d)

	case ctl.EventInteractionSettled:
		var d ctl.InteractionSettledData
		if err := ev.Decode(&d); err != nil || d.ID == 0 {
			return
		}
		v.interactions = slices.DeleteFunc(v.interactions, func(p ctl.InteractionPendingData) bool {
			return p.ID == d.ID
		})
		delete(v.dialogSeen, d.ID)

	case ctl.EventSeatLost: // displaced without probing; the new holder is named
		var d ctl.SeatLostData
		if err := ev.Decode(&d); err != nil || d.To == "" {
			return
		}
		v.seat = ctl.SeatState{Held: true, Holder: d.To}
	}
}

// applyStatus handles the one-of-three status family.
func (v *view) applyStatus(ev ctl.Event) {
	var d ctl.StatusData
	if err := ev.Decode(&d); err != nil {
		return
	}
	switch {
	case d.Segment != nil:
		seg := *d.Segment
		if seg.Key == "" {
			return
		}
		if seg.Text == "" { // empty text removes the keyed row
			delete(v.segments, seg.Key)
		} else {
			v.segments[seg.Key] = seg
		}
	case d.Model != nil:
		v.model = *d.Model
	case d.Spinning != nil:
		v.spinning = *d.Spinning
	}
}

// pendingInteraction records one open dialog; a re-announcement updates in place.
func (v *view) pendingInteraction(d ctl.InteractionPendingData) {
	if i := slices.IndexFunc(v.interactions, func(p ctl.InteractionPendingData) bool { return p.ID == d.ID }); i >= 0 {
		v.interactions[i] = d
		return
	}
	v.interactions = append(v.interactions, d)
	v.dialogSeen[d.ID] = time.Now().UnixMilli()
}

// oldestDialog names the longest-waiting open dialog and when swarm first saw
// it, zero when nothing holds input.
func (v *view) oldestDialog() (ctl.InteractionPendingData, int64) {
	if len(v.interactions) == 0 {
		return ctl.InteractionPendingData{}, 0
	}
	dlg := v.interactions[0] // kept oldest first
	return dlg, v.dialogSeen[dlg.ID]
}

// activityPreview returns the top-ranked activity row's text for the digest.
func (v *view) activityPreview() string {
	rows := sortedActivity(v.activity)
	if len(rows) == 0 {
		return ""
	}
	return rows[0].Text
}

// firstUserPrompt returns the typed user text of a committed message entry,
// "" for everything else. It mirrors ajent's own prompt classification:
// user role, not system-injected, not a tool-result carrier.
func firstUserPrompt(e ctl.Entry) string {
	if e.Type != string(session.TypeMessage) || len(e.Data) == 0 {
		return ""
	}
	var md session.MessageData
	if json.Unmarshal(e.Data, &md) != nil {
		return ""
	}
	if !isUserPrompt(md) {
		return ""
	}
	return strings.TrimSpace(llm.JoinText(md.Message.Content))
}

// snapshot rebuilds the state.get shape from what events have kept current.
func (v *view) snapshot() ctl.State {
	st := ctl.State{
		Session:      v.session,
		Workspace:    v.workspace,
		Cwd:          v.cwd,
		Head:         v.head,
		Model:        v.model,
		Permission:   v.permission,
		Usage:        v.usage,
		Context:      v.context,
		Running:      v.running,
		Idle:         v.idle,
		Spinning:     v.spinning,
		Queued:       len(v.queuedRows),
		Seat:         v.seat,
		Interactions: slices.Clone(v.interactions),
	}
	st.Tools = cloneTools(v.tools)
	if v.queuedRows != nil {
		st.QueuedRows = slices.Clone(v.queuedRows)
	} else {
		st.QueuedRows = []ctl.QueueRow{}
	}
	st.Activity = sortedActivity(v.activity)
	st.Status.Segments = sortedSegments(v.segments)
	return st
}

// cloneTools always returns a non-nil copy so snapshots encode [] not null.
func cloneTools(rows []ctl.ToolState) []ctl.ToolState {
	if rows == nil {
		return []ctl.ToolState{}
	}
	return slices.Clone(rows)
}

// sortedActivity orders keyed activity rows by rank, then key for stability.
func sortedActivity(rows map[string]ctl.ActivityRow) []ctl.ActivityRow {
	out := bulk.MapValuesSlice(rows)
	slices.SortFunc(out, func(a, b ctl.ActivityRow) int {
		if a.Rank != b.Rank {
			return a.Rank - b.Rank
		}
		return strings.Compare(a.Key, b.Key)
	})
	return out
}

// sortedSegments orders keyed status segments by their declared order.
func sortedSegments(rows map[string]ctl.Segment) []ctl.Segment {
	out := bulk.MapValuesSlice(rows)
	slices.SortFunc(out, func(a, b ctl.Segment) int {
		if a.Order != b.Order {
			return a.Order - b.Order
		}
		return strings.Compare(a.Key, b.Key)
	})
	return out
}

// appendEntry adds one committed entry, deduping by id against backfill
// overlap. The head follows the committed family wherever it lands.
func (v *view) appendEntry(e ctl.Entry) {
	if _, dup := v.seen[e.ID]; !dup {
		rec := entryRecord{e: e, size: len(e.Data) + 128}
		v.entries = append(v.entries, rec)
		v.seen[e.ID] = struct{}{}
		v.entryBytes += rec.size
		v.trimEntries()
	}
	v.head = e.ID
}

// trimEntries drops the oldest entries once retention bounds overflow.
func (v *view) trimEntries() {
	for len(v.entries) > maxRetainedEntries || v.entryBytes > maxRetainedBytes {
		oldest := v.entries[0]
		v.entries = v.entries[1:]
		delete(v.seen, oldest.e.ID)
		v.entryBytes -= oldest.size
	}
	if len(v.entries) == 0 {
		v.entries = nil
	}
}

// tailEntries walks items backwards from end, oldest first: the newest entry
// always rides along, then the walk stops once limit entries or the byte
// budget is reached. The cursor continues the walk as the id of the oldest
// entry taken, empty when history starts there.
func tailEntries[T any](items []T, end, limit int, size func(T) int, shape func(T) ctl.Entry) ([]ctl.Entry, string) {
	out := make([]ctl.Entry, 0, min(end, limit))
	used := 0
	i := end - 1
	for ; i >= 0; i-- {
		if len(out) > 0 && (len(out) >= limit || used >= initMaxBytes) {
			break
		}
		out = append(out, shape(items[i]))
		used += size(items[i])
	}
	slices.Reverse(out)
	cursor := ""
	if i >= 0 && len(out) > 0 {
		cursor = out[0].ID
	}
	return out, cursor
}

// initTail returns the newest committed entries for an init, bounded by count
// and bytes, with base64 image bodies deferred to lazy loads.
func (v *view) initTail() ([]ctl.Entry, string) {
	return tailEntries(v.entries, len(v.entries), initMaxEntries,
		func(r entryRecord) int { return r.size },
		func(r entryRecord) ctl.Entry { return deferImageBodies(r.e) })
}

// pageEntries returns up to limit full-fidelity entries older than before,
// oldest first. An empty before walks back from the newest entry; an unknown
// cursor yields an empty page.
func (v *view) pageEntries(before string, limit int) ([]ctl.Entry, string) {
	end := len(v.entries)
	if before != "" {
		idx := slices.IndexFunc(v.entries, func(rec entryRecord) bool { return rec.e.ID == before })
		if idx < 0 {
			return []ctl.Entry{}, ""
		}
		end = idx
	}
	return tailEntries(v.entries, end, min(max(limit, 1), pageMaxEntries),
		func(r entryRecord) int { return r.size },
		func(r entryRecord) ctl.Entry { return r.e })
}

// deferImageBodies replaces base64 image payloads with their media type so an
// init never carries megabytes of pixels; /entries returns the full bodies.
func deferImageBodies(e ctl.Entry) ctl.Entry {
	stripped, changed := stripImages(e.Data)
	if !changed {
		return e
	}
	e.Data = stripped
	return e
}

// stripImages walks one JSON value replacing every image block body
// {"mediaType":..., "data":...} with its media type alone. It reports whether
// anything changed; untouched values keep their exact bytes.
func stripImages(raw json.RawMessage) (json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || !bytes.Contains(trimmed, []byte(`"image"`)) {
		return raw, false
	}
	switch trimmed[0] {
	case '{':
		var obj map[string]json.RawMessage
		if json.Unmarshal(trimmed, &obj) != nil {
			return raw, false
		}
		changed := false
		for k, val := range obj {
			nv, c := stripImages(val)
			if c {
				obj[k] = nv
				changed = true
			}
		}
		if t, ok := obj["type"]; ok && string(t) == `"image"` {
			var body struct {
				MediaType string `json:"mediaType"`
			}
			if err := json.Unmarshal(obj["data"], &body); err == nil {
				obj["data"] = mustJSON(body)
				changed = true
			}
		}
		if !changed {
			return raw, false
		}
		out, err := json.Marshal(obj)
		if err != nil { // unreachable: rebuilt from decoded JSON values
			return raw, false
		}
		return out, true

	case '[':
		var items []json.RawMessage
		if json.Unmarshal(trimmed, &items) != nil {
			return raw, false
		}
		changed := false
		for i, val := range items {
			nv, c := stripImages(val)
			if c {
				items[i] = nv
				changed = true
			}
		}
		if !changed {
			return raw, false
		}
		out, err := json.Marshal(items)
		if err != nil {
			return raw, false
		}
		return out, true

	default:
		return raw, false
	}
}

// mustJSON encodes v; only unreachable types fail here.
func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic("fleet: encode " + err.Error())
	}
	return b
}
