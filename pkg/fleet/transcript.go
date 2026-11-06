package fleet

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/go-analyze/bulk"
	"github.com/jentfoo/ajent/pkg/client"
	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/session"
)

// ErrUnknownSaved and ErrAmbiguousSaved report what the saved-session
// target resolution answered with.
var (
	ErrUnknownSaved   = errors.New("unknown saved session")
	ErrAmbiguousSaved = errors.New("ambiguous saved session")
)

// SavedSession is one row of the resume picker listing. Target is what
// --resume takes back for the row: its name, else its id.
type SavedSession struct {
	ID        string `json:"id"`
	Name      string `json:"name,omitempty"`
	Target    string `json:"target"`
	Workspace string `json:"workspace,omitempty"`
	Model     string `json:"model,omitempty"`
	StartedMs int64  `json:"startedMs,omitempty"` // unix milliseconds
	UpdatedMs int64  `json:"updatedMs"`           // unix milliseconds
	Messages  int    `json:"messages"`
	First     string `json:"first,omitempty"`
	Blocked   bool   `json:"blocked"` // recorded in a newer format; resume would refuse it
	Live      bool   `json:"live"`    // tracked by the fleet right now
}

// SavedEntriesPage answers one offline transcript read: the branch under a
// tip derived at read time, paged oldest-first like the live endpoint.
type SavedEntriesPage struct {
	SessionID string      `json:"sessionId"`
	Head      string      `json:"head"` // the derived branch tip
	Path      string      `json:"path,omitempty"`
	Entries   []ctl.Entry `json:"entries"`
	Cursor    string      `json:"cursor,omitempty"` // id of the oldest entry included
}

// SavedSessions lists every saved session under the ajent home, most
// recently used first, each with the resume target derived from its row.
func (m *Manager) SavedSessions() ([]SavedSession, error) {
	rows, err := client.SavedSessions()
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	live := make(map[string]struct{}, len(m.actors))
	for key := range m.actors {
		live[key.sessionID] = struct{}{}
	}
	m.mu.Unlock()
	out := make([]SavedSession, 0, len(rows))
	for _, row := range rows {
		_, isLive := live[row.ID]
		target := row.ID // resume handle: the name, else the id
		if row.Name != "" {
			target = row.Name
		}
		out = append(out, SavedSession{
			ID:        row.ID,
			Name:      row.Name,
			Target:    target,
			Workspace: row.Workspace,
			Model:     row.Model,
			StartedMs: unixMilli(row.Started),
			UpdatedMs: unixMilli(row.Updated),
			Messages:  row.Messages,
			First:     row.First,
			Blocked:   row.Blocked,
			Live:      isLive,
		})
	}
	return out, nil
}

// SavedEntries reads one recorded transcript for offline browsing: the file
// read branches by a tip derived at read time, since listings carry no head.
// before names the previous page's oldest entry; the cursor continues back.
func (m *Manager) SavedEntries(target, before string, limit int) (SavedEntriesPage, error) {
	row, err := m.savedRow(target)
	if err != nil {
		return SavedEntriesPage{}, err
	}
	if row.Blocked {
		return SavedEntriesPage{}, fmt.Errorf("session %s is recorded in a newer format: %w",
			row.ID, session.ErrNewerFormat)
	}
	entries, _, err := session.Read(row.Path)
	if err != nil {
		return SavedEntriesPage{}, fmt.Errorf("reading transcript: %w", err)
	}
	head := recordedTip(entries)
	branch := session.Branch(entries, head)
	page, cursor := pageBranch(branch, before, limit)
	return SavedEntriesPage{
		SessionID: row.ID,
		Head:      head,
		Path:      row.Path,
		Entries:   page,
		Cursor:    cursor,
	}, nil
}

// savedRow resolves a resume-style target against the cross-workspace
// listing: an exact id first, then a unique id prefix, then a unique name.
func (m *Manager) savedRow(target string) (session.Listed, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		return session.Listed{}, fmt.Errorf("%w: empty target", ErrUnknownSaved)
	}
	rows, err := client.SavedSessions()
	if err != nil {
		return session.Listed{}, err
	}
	if row, err := findSavedRow(rows, target); err == nil {
		return row, nil
	} else if !errors.Is(err, errNoSavedMatch) {
		return session.Listed{}, err
	}
	return session.Listed{}, fmt.Errorf("%w: %s", ErrUnknownSaved, target)
}

// errNoSavedMatch reports a target that matched no row; findSavedRow uses it
// to tell misses apart from ambiguity and store errors.
var errNoSavedMatch = errors.New("no saved session matches")

func findSavedRow(rows []session.Listed, target string) (session.Listed, error) {
	if i := slices.IndexFunc(rows, func(r session.Listed) bool { return r.ID == target }); i >= 0 {
		return rows[i], nil
	}
	prefixed := bulk.SliceFilter(func(r session.Listed) bool {
		return strings.HasPrefix(r.ID, target)
	}, rows)
	if len(prefixed) == 1 {
		return prefixed[0], nil
	}
	named := bulk.SliceFilter(func(r session.Listed) bool {
		return r.Name != "" && strings.EqualFold(r.Name, target)
	}, rows)
	switch len(named) {
	case 1:
		return named[0], nil
	case 0:
		return session.Listed{}, errNoSavedMatch
	default:
		paths := make([]string, 0, len(named))
		for _, r := range named {
			paths = append(paths, r.Path)
		}
		return session.Listed{}, fmt.Errorf("%w: %q names %d sessions: %s",
			ErrAmbiguousSaved, target, len(named), strings.Join(paths, ", "))
	}
}

// recordedTip derives a recorded transcript's tip at read time: among the
// entries nothing references as a parent, the one with the newest ts wins,
// ids being ULIDs so they break exact ties in creation order. A rewind
// leaves the abandoned fork's leaf aging while the live branch kept
// appending, so the newest leaf converges on where the recording sits.
func recordedTip(entries []session.Entry) string {
	if len(entries) == 0 {
		return ""
	}
	parents := make(map[string]struct{}, len(entries))
	for _, e := range entries {
		if e.ParentID != "" {
			parents[e.ParentID] = struct{}{}
		}
	}
	var tip session.Entry
	var has bool
	better := func(e session.Entry) bool {
		return !has || e.TS > tip.TS || (e.TS == tip.TS && e.ID > tip.ID)
	}
	for _, e := range entries {
		if _, referenced := parents[e.ID]; referenced {
			continue
		}
		if better(e) {
			tip, has = e, true
		}
	}
	if !has { // every entry referenced: a corrupt tree; the file tail stands in
		tip = entries[len(entries)-1]
	}
	return tip.ID
}

// pageBranch windows one oldest-first branch like the live entries endpoint:
// before names the previous page's oldest entry, and the returned cursor
// continues the walk. An unknown cursor yields an empty page.
func pageBranch(branch []session.Entry, before string, limit int) ([]ctl.Entry, string) {
	end := len(branch)
	if before != "" {
		idx := slices.IndexFunc(branch, func(e session.Entry) bool { return e.ID == before })
		if idx < 0 {
			return []ctl.Entry{}, ""
		}
		end = idx
	}
	limit = min(max(limit, 1), pageMaxEntries)

	out := make([]ctl.Entry, 0, min(end, limit))
	used := 0
	i := end - 1
	for ; i >= 0; i-- {
		if len(out) > 0 && (len(out) >= limit || used >= initMaxBytes) {
			break
		}
		out = append(out, wireEntry(branch[i]))
		used += len(branch[i].Data) + 128
	}
	slices.Reverse(out)
	cursor := ""
	if i >= 0 && len(out) > 0 {
		cursor = out[0].ID
	}
	return out, cursor
}

// unixMilli renders a listing timestamp; zero stays zero.
func unixMilli(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}
