package fleet

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/llm"
	"github.com/jentfoo/ajent/pkg/session"
)

// pageDefault is test-only; production paging defaults live in pkg/api.
const pageDefault = 200

// seqEvent builds one event outside the stub for view-level tests.
func seqEvent(name string, s uint64, data any) ctl.Event {
	return ctl.NewEvent(name, s, data)
}

// emptyView seeds a view at watermark 10 with no entries.
func emptyView() *view {
	return buildView(ctl.State{Session: ctl.Session{ID: "s1"}, Head: "h0"}, nil, 10)
}
func TestView(t *testing.T) {
	t.Parallel()

	t.Run("watermark_drops", func(t *testing.T) {
		cases := []struct {
			name string
			seq  uint64
			want bool // whether the event applies
		}{
			{"below watermark", 9, false},
			{"at watermark", 10, false},
			{"above watermark", 11, true},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				v := emptyView()
				ev := seqEvent(ctl.EventIdle, tc.seq, ctl.IdleData{Idle: true})
				v.apply(ev)
				assert.Equal(t, tc.want, v.idle)
				if tc.want {
					assert.Equal(t, tc.seq, v.seq)
				} else {
					assert.Equal(t, uint64(10), v.seq)
				}
			})
		}
	})

	t.Run("entry_append_dedupe_and_head", func(t *testing.T) {
		a := ctl.Entry{ID: "a", Type: string(session.TypeMessage)}
		b := ctl.Entry{ID: "b", ParentID: "a", Type: string(session.TypeSession)}
		c := ctl.Entry{ID: "c", ParentID: "b", Type: string(session.TypeMessage)}

		v := buildView(ctl.State{Head: "h0"}, []session.Entry{
			{ID: a.ID, Type: session.TypeMessage},
			{ID: b.ID, ParentID: b.ParentID, Type: session.TypeSession},
		}, 10)
		require.Len(t, v.entries, 2)

		t.Run("overlap_applies_once", func(t *testing.T) {
			v.apply(seqEvent(ctl.EventEntryAppend, 11, ctl.EntryData{Entry: b}))
			assert.Len(t, v.entries, 2) // no duplicate from backfill overlap
			assert.Equal(t, "b", v.head)
		})

		t.Run("fresh_append_extends_the_branch", func(t *testing.T) {
			v.apply(seqEvent(ctl.EventEntryAppend, 12, ctl.EntryData{Entry: c}))
			require.Len(t, v.entries, 3)
			assert.Equal(t, "c", v.head)
		})
	})

	t.Run("only_committed_family_moves_head", func(t *testing.T) {
		v := emptyView()
		v.apply(seqEvent(ctl.EventStatus, 11, ctl.StatusData{
			Model: &ctl.ModelState{Key: "p/m"},
		}))
		assert.Equal(t, "h0", v.head)

		v.apply(seqEvent(ctl.EventBranchChanged, 12, ctl.BranchChangedData{From: "h0", Head: "h1"}))
		assert.Equal(t, "h1", v.head)
	})

	t.Run("keyed_families", func(t *testing.T) {
		t.Run("status_segments_by_key", func(t *testing.T) {
			v := emptyView()
			v.apply(seqEvent(ctl.EventStatus, 11, ctl.StatusData{
				Segment: &ctl.Segment{Key: "k1", Text: "one", Order: 1},
			}))
			v.apply(seqEvent(ctl.EventStatus, 12, ctl.StatusData{
				Segment: &ctl.Segment{Key: "k2", Text: "two", Order: 0},
			}))
			segs := v.snapshot().Status.Segments
			require.Len(t, segs, 2)
			assert.Equal(t, "k2", segs[0].Key) // order 0 sorts first

			v.apply(seqEvent(ctl.EventStatus, 13, ctl.StatusData{
				Segment: &ctl.Segment{Key: "k1"}, // empty text removes
			}))
			segs = v.snapshot().Status.Segments
			require.Len(t, segs, 1)
			assert.Equal(t, "k2", segs[0].Key)
		})

		t.Run("activity_rows_by_key", func(t *testing.T) {
			v := emptyView()
			v.apply(seqEvent(ctl.EventActivity, 11, ctl.ActivityRow{Key: "a1", Text: "one", Rank: 2}))
			v.apply(seqEvent(ctl.EventActivity, 12, ctl.ActivityRow{Key: "a1", Text: "one replaced", Rank: 2}))
			v.apply(seqEvent(ctl.EventActivity, 13, ctl.ActivityRow{Key: "a2", Text: "two", Rank: 1}))

			rows := v.snapshot().Activity
			require.Len(t, rows, 2)
			assert.Equal(t, []string{"a2", "a1"}, []string{rows[0].Key, rows[1].Key}) // rank order

			v.apply(seqEvent(ctl.EventActivity, 14, ctl.ActivityRow{Key: "a1"}))
			rows = v.snapshot().Activity
			require.Len(t, rows, 1)
			assert.Equal(t, "a2", rows[0].Key)
		})

		t.Run("queued_replaces_by_id", func(t *testing.T) {
			v := emptyView()
			v.apply(seqEvent(ctl.EventQueued, 11, ctl.QueuedData{Rows: []ctl.QueueRow{
				{ID: "c1", Text: "one"}, {ID: "c2", Text: "two"},
			}}))
			require.Len(t, v.queuedRows, 2)

			v.apply(seqEvent(ctl.EventQueueDropped, 12, ctl.QueueDroppedData{
				Rows: []ctl.QueueRow{{ID: "c1"}}, Cause: "interrupt",
			}))
			rows := v.snapshot().QueuedRows
			require.Len(t, rows, 1)
			assert.Equal(t, "c2", rows[0].ID)
			assert.Equal(t, 1, v.snapshot().Queued) // the count follows the rows
		})

		t.Run("tools_replace_wholesale", func(t *testing.T) {
			v := emptyView()
			v.apply(seqEvent(ctl.EventTools, 11, ctl.ToolsData{Rows: []ctl.ToolState{
				{Name: "bash", Enabled: true},
				{Name: "edit", Enabled: false},
			}}))

			// the next event replaces the list wholesale instead of merging rows
			v.apply(seqEvent(ctl.EventTools, 12, ctl.ToolsData{Rows: []ctl.ToolState{
				{Name: "bash", Enabled: false},
			}}))
			rows := v.snapshot().Tools
			require.Len(t, rows, 1)
			assert.Equal(t, "bash", rows[0].Name)
			assert.False(t, rows[0].Enabled)

			v.apply(seqEvent(ctl.EventTools, 13, ctl.ToolsData{})) // empty list clears
			assert.Empty(t, v.snapshot().Tools)
		})
	})

	t.Run("interactions_lifecycle", func(t *testing.T) {
		v := emptyView()
		pending := ctl.InteractionPendingData{ID: 7, Kind: "confirm", Prompt: "allow?"}
		v.apply(seqEvent(ctl.EventInteractionPending, 11, pending))
		require.Len(t, v.interactions, 1)

		// a re-announcement updates in place rather than stacking
		same := pending
		same.Subject = "diff"
		v.apply(seqEvent(ctl.EventInteractionPending, 12, same))
		require.Len(t, v.interactions, 1)
		assert.Equal(t, "diff", v.interactions[0].Subject)

		v.apply(seqEvent(ctl.EventInteractionSettled, 13, ctl.InteractionSettledData{ID: 7}))
		assert.Empty(t, v.interactions)
		assert.Empty(t, v.dialogSeen) // the seen ledger prunes with its dialog
	})

	t.Run("oldest_dialog_and_activity_preview", func(t *testing.T) {
		v := emptyView()
		dlg, at := v.oldestDialog()
		assert.Zero(t, dlg.ID)
		assert.Zero(t, at)
		assert.Empty(t, v.activityPreview())

		v.apply(seqEvent(ctl.EventActivity, 11, ctl.ActivityRow{Key: "b", Text: "second", Rank: 2}))
		v.apply(seqEvent(ctl.EventActivity, 12, ctl.ActivityRow{Key: "a", Text: "first", Rank: 1}))
		assert.Equal(t, "first", v.activityPreview()) // rank orders the preview

		v.apply(seqEvent(ctl.EventInteractionPending, 13,
			ctl.InteractionPendingData{ID: 1, Kind: "confirm", Prompt: "first?"}))
		v.apply(seqEvent(ctl.EventInteractionPending, 14,
			ctl.InteractionPendingData{ID: 2, Kind: "confirm", Prompt: "second?"}))
		dlg, at = v.oldestDialog()
		assert.Equal(t, uint64(1), dlg.ID) // interactions stay oldest first
		assert.Positive(t, at)

		// an empty activity row removes its key, promoting the next rank
		v.apply(seqEvent(ctl.EventActivity, 15, ctl.ActivityRow{Key: "a", Text: "", Rank: 1}))
		assert.Equal(t, "second", v.activityPreview())
	})

	t.Run("resnapshot_clears_dialogs", func(t *testing.T) {
		// dialog ids never survive a reconnect: the rebuilt view lists only what
		// the new snapshot lists
		v := buildView(ctl.State{
			Interactions: []ctl.InteractionPendingData{{ID: 9, Kind: "pick", Prompt: "choose"}},
		}, nil, 4)
		require.Len(t, v.interactions, 1)

		fresh := buildView(ctl.State{}, nil, 8) // a later resnapshot lists none
		assert.Empty(t, fresh.interactions)
	})

	t.Run("seat_lost_records_holder", func(t *testing.T) {
		v := emptyView()
		v.seat = ctl.SeatState{Held: true, Holder: holderName, Yours: true}
		v.apply(seqEvent(ctl.EventSeatLost, 11, ctl.SeatLostData{From: holderName, To: "human"}))

		seat := v.snapshot().Seat
		assert.True(t, seat.Held)
		assert.Equal(t, "human", seat.Holder)
		assert.False(t, seat.Yours) // displaced without probing, never re-forcing
	})

	t.Run("turn_lifecycle_running_end", func(t *testing.T) {
		v := emptyView()
		assert.False(t, v.running)

		v.apply(seqEvent(ctl.EventTurnStart, 11, ctl.TurnStartData{Model: "p/m"}))
		assert.True(t, v.running)
		assert.Zero(t, v.lastTurnEnd)

		v.apply(seqEvent(ctl.EventTurnEnd, 12, ctl.TurnEndData{Stop: "end_turn"}))
		assert.False(t, v.running)
		assert.Positive(t, v.lastTurnEnd)
		assert.Equal(t, "end_turn", v.lastStop)
		assert.Empty(t, v.lastStopErr)

		v.apply(seqEvent(ctl.EventTurnEnd, 13, ctl.TurnEndData{Stop: "error", Err: "context full"}))
		assert.Equal(t, "error", v.lastStop)
		assert.Equal(t, "context full", v.lastStopErr)
	})

	t.Run("init_tail_bounds_and_cursor", func(t *testing.T) {
		t.Run("short_history_is_complete", func(t *testing.T) {
			v := emptyView()
			for i, id := range []string{"a", "b", "c"} {
				v.appendEntry(ctl.Entry{ID: id, TS: int64(i)})
			}
			entries, cursor := v.initTail()
			require.Len(t, entries, 3)
			assert.Empty(t, cursor)
			assert.Equal(t, "a", entries[0].ID) // oldest first
		})

		t.Run("count_bound_leaves_a_cursor", func(t *testing.T) {
			v := emptyView()
			for i := range initMaxEntries + 50 {
				id := fmt.Sprintf("e%05d", i)
				v.appendEntry(ctl.Entry{ID: id, TS: int64(i)})
			}
			entries, cursor := v.initTail()
			assert.Len(t, entries, initMaxEntries)
			require.NotEmpty(t, cursor)
			assert.Equal(t, entries[0].ID, cursor)

			page, pageCursor := v.pageEntries(cursor, pageDefault) // paging reaches further back
			assert.Len(t, page, 50)
			assert.Empty(t, pageCursor)
		})
	})

	t.Run("page_entries", func(t *testing.T) {
		v := emptyView()
		for _, id := range []string{"e1", "e2", "e3", "e4"} {
			v.appendEntry(ctl.Entry{ID: id})
		}

		t.Run("before_walks_backwards_oldest_first", func(t *testing.T) {
			page, cursor := v.pageEntries("e3", 10)
			require.Len(t, page, 2)
			assert.Equal(t, "e1", page[0].ID)
			assert.Empty(t, cursor) // reached the start
		})

		t.Run("limit_bounds_and_reports_continuation", func(t *testing.T) {
			page, cursor := v.pageEntries("e4", 2)
			require.Len(t, page, 2) // the newest entries older than e4
			assert.Equal(t, "e2", page[0].ID)
			assert.Equal(t, "e2", cursor) // the oldest entry of this page continues the walk

			tail, tailCursor := v.pageEntries(cursor, 10)
			require.Len(t, tail, 1)
			assert.Equal(t, "e1", tail[0].ID)
			assert.Empty(t, tailCursor)
		})

		t.Run("unknown_cursor_empty_page", func(t *testing.T) {
			page, cursor := v.pageEntries("missing", 10)
			assert.Empty(t, page)
			assert.Empty(t, cursor)
		})
	})

	t.Run("init_defers_image_bodies", func(t *testing.T) {
		md := session.MessageData{Message: llm.Message{
			Role: llm.RoleUser,
			Content: llm.BlockList{
				llm.TextBlock{Text: "hi"},
				llm.ImageBlock{MediaType: "image/png", Data: []byte("hello")},
			},
		}}
		data, err := json.Marshal(md)
		require.NoError(t, err)

		v := emptyView()
		v.appendEntry(ctl.Entry{ID: "with-image", Type: string(session.TypeMessage), Data: data})

		// the entry itself is untouched; only the init tail defers bodies
		entries, _ := v.initTail()
		require.Len(t, entries, 1)
		assert.Contains(t, string(entries[0].Data), `"mediaType":"image/png"`)
		assert.NotContains(t, string(entries[0].Data), "aGVsbG8=")

		page, _ := v.pageEntries("", 10) // full fidelity over REST
		require.Len(t, page, 1)
		assert.Contains(t, string(page[0].Data), "aGVsbG8=")
	})
}
