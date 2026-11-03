package fleet

import (
	"context"
	"slices"
	"strings"

	"github.com/go-analyze/bulk"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// ToolOptions unions every served session's snapshot tool rows by name: the
// best-effort suggestion list a job editor offers. Availability differs per
// workspace, since MCP servers are configured per project, so a missing row
// here only means no live session reported it. A session that will not answer
// just drops out of the union.
func (m *Manager) ToolOptions(ctx context.Context) []ctl.ToolState {
	byName := make(map[string]ctl.ToolState)
	for _, st := range m.servingStatuses() {
		rctx, cancel := context.WithTimeout(ctx, modelRowWait)
		state, err := m.Snapshot(rctx, st.SessionID)
		cancel()
		if err != nil { // an actor mid-teardown just drops out
			continue
		}
		for _, row := range state.Tools {
			byName[row.Name] = row
		}
	}
	out := bulk.MapValuesSlice(byName)
	slices.SortFunc(out, func(a, b ctl.ToolState) int { return strings.Compare(a.Name, b.Name) })
	return out
}
