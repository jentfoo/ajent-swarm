package fleet

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent/pkg/ctl"
)

// newTestSub builds a subscription with its queue drained into a channel. The
// third return flags whether the subscriber was dropped as slow.
func newTestSub(t *testing.T, sessionID string) (*subscription, <-chan []byte, *bool) {
	t.Helper()
	out := make(chan []byte, 256)
	dropped := new(bool)
	sub := &subscription{
		sessionID: sessionID,
		q:         make(chan []byte, subQueue),
		closed:    make(chan struct{}),
		deliver:   func(b []byte) { out <- b },
		onDrop:    func() { *dropped = true },
	}
	go sub.forward()
	return sub, out, dropped
}

func BenchmarkHubFanout(b *testing.B) {
	for _, viewers := range []int{1, 16, 64} {
		b.Run(fmt.Sprintf("viewers-%d", viewers), func(b *testing.B) {
			h := newHub()
			for i := range viewers {
				sub := &subscription{
					id:        int64(i + 1),
					sessionID: "s1",
					q:         make(chan []byte, subQueue),
					closed:    make(chan struct{}),
					deliver:   func([]byte) {},
					onDrop:    func() {},
				}
				h.attach(sub)
				go sub.forward()
			}

			evs := make([]ctl.Event, 200)
			for i := range evs {
				evs[i] = ctl.NewEvent(ctl.EventTextDelta, uint64(i+1), ctl.TextData{Delta: "x"})
			}

			b.ResetTimer()
			for range b.N {
				for _, ev := range evs {
					h.publishEvent("s1", ev)
				}
			}
		})
	}
}
func TestHub(t *testing.T) {
	t.Run("coalesces delta bursts", func(t *testing.T) {
		sub, out, _ := newTestSub(t, "s1")

		const bursts = 50
		for i := range bursts { // one streaming turn's worth of deltas
			sub.publish(ctl.NewEvent(ctl.EventTextDelta, uint64(i+1), ctl.TextData{Delta: "d"}), nil)
		}
		// a committed event flushes what staged and passes through verbatim
		appended := ctl.NewEvent(ctl.EventEntryAppend, bursts+1, ctl.EntryData{
			Entry: ctl.Entry{ID: "e1", Type: "message"},
		})
		sub.publish(appended, mustJSON(EventFrame{Type: FrameEvent, SessionID: "s1", Event: appended}))

		merged := readFrame(t, out)
		require.Equal(t, FrameEvent, merged.env.Type)
		var mergedDelta ctl.TextData
		require.NoError(t, json.Unmarshal(merged.env.Event.Data, &mergedDelta))
		assert.Len(t, []rune(mergedDelta.Delta), bursts)      // every delta merged
		assert.Equal(t, uint64(bursts), merged.env.Event.Seq) // the highest seq survives

		verbatim := readFrame(t, out)
		require.Equal(t, FrameEvent, verbatim.env.Type)
		assert.Equal(t, ctl.EventEntryAppend, verbatim.env.Event.Name)
		assert.Equal(t, uint64(bursts+1), verbatim.env.Event.Seq)

		select { // nothing else was manufactured
		case b := <-out:
			t.Fatalf("unexpected frame %s", b)
		default:
		}
	})

	t.Run("keeps tool streams apart", func(t *testing.T) {
		sub, out, _ := newTestSub(t, "s1")
		delta := func(id string, seq uint64, text string) ctl.Event {
			return ctl.NewEvent(ctl.EventToolOutput, seq, ctl.ToolOutputData{ID: id, Delta: text})
		}

		sub.publish(delta("A", 1, "a1"), nil)
		sub.publish(delta("B", 2, "b1"), nil)
		sub.publish(delta("A", 3, "a2"), nil)
		end := ctl.NewEvent(ctl.EventToolResult, 4, ctl.ToolResultData{ID: "A"})
		sub.publish(end, mustJSON(EventFrame{Type: FrameEvent, SessionID: "s1", Event: end}))

		first := readFrame(t, out) // A's first delta flushed before B staged
		require.Equal(t, ctl.EventToolOutput, first.env.Event.Name)
		second := readFrame(t, out)
		require.Equal(t, ctl.EventToolOutput, second.env.Event.Name)

		var da, db ctl.ToolOutputData
		for _, tc := range []struct {
			fr   frame
			dst  *ctl.ToolOutputData
			want string
		}{{first, &da, "a1"}, {second, &db, "b1"}} {
			require.NoError(t, json.Unmarshal(tc.fr.env.Event.Data, tc.dst))
			assert.Equal(t, tc.want, tc.dst.Delta)
		}
	})

	t.Run("slow reader dropped not blocking", func(t *testing.T) {
		dropped := new(bool)
		sub := &subscription{
			sessionID: "s1",
			q:         make(chan []byte, 2), // nobody drains it
			closed:    make(chan struct{}),
			deliver:   func([]byte) {},
			onDrop:    func() { *dropped = true },
		}

		done := make(chan struct{})
		go func() {
			for i := range 100 {
				ev := ctl.NewEvent(ctl.EventNotice, uint64(i+1), ctl.NoticeData{Text: "x"})
				sub.publish(ev, mustJSON(EventFrame{Type: FrameEvent, SessionID: "s1", Event: ev}))
			}
			close(done)
		}()
		select { // overflow drops instead of blocking the actor
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("publish blocked on a stalled reader")
		}

		sub.mu.Lock()
		wasDropped := sub.dropped
		sub.mu.Unlock()
		assert.True(t, wasDropped)
		assert.True(t, *dropped)

		sub.publishFrame([]byte("{}")) // a dropped subscription ignores further work
	})

	t.Run("child frame flushes pending delta", func(t *testing.T) {
		sub, out, _ := newTestSub(t, "s1")
		sub.publish(ctl.NewEvent(ctl.EventTextDelta, 5, ctl.TextData{Delta: "d"}), nil)
		sub.publishFrame(mustJSON(ChildFrame{Type: FrameChild, SessionID: "s1", State: ChildOnline}))

		delta := readFrame(t, out) // order holds: staged delta first
		require.Equal(t, FrameEvent, delta.env.Type)
		child := readFrame(t, out)
		assert.Equal(t, FrameChild, child.env.Type)
	})

	t.Run("coalesce window flushes quiet streams", func(t *testing.T) {
		sub, out, _ := newTestSub(t, "s1")
		for i := range 10 { // the stream goes quiet right after this burst
			sub.publish(ctl.NewEvent(ctl.EventThinkingDelta, uint64(i+1), ctl.TextData{Delta: "t"}), nil)
		}

		var merged ctl.TextData
		require.Eventually(t, func() bool {
			raw := pollFrame(out)
			if raw == nil {
				return false
			}
			var f struct {
				Event ctl.Event `json:"event"`
			}
			if json.Unmarshal(raw, &f) != nil || f.Event.Data == nil {
				return false
			}
			return json.Unmarshal(f.Event.Data, &merged) == nil && merged.Delta != ""
		}, time.Second, 20*time.Millisecond)
		assert.Len(t, []rune(merged.Delta), 10) // the window batched the whole burst
	})
}

func pollFrame(in <-chan []byte) []byte {
	select {
	case b := <-in:
		return b
	default:
		return nil
	}
}
