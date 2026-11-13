package fleet

import "github.com/jentfoo/ajent/pkg/ctl"

// Frame types on /api/stream. Client frames carry only the three verbs,
// everything a session emits arrives as event or child frames after an init.
const (
	FrameInit      = "init"
	FrameEvent     = "event"
	FrameChild     = "child"
	FrameError     = "error"
	FrameHeartbeat = "heartbeat"

	FrameSubscribe   = "subscribe"
	FrameUnsubscribe = "unsubscribe"
	FrameSync        = "sync"
)

// Child states ride child frames and the session listing: lifecycle facts
// only swarm knows, never announced by ajent itself.
const (
	ChildOnline       = "online"
	ChildReconnecting = "reconnecting"
	ChildExited       = "exited"
	ChildGone         = "gone" // removed from the fleet, no longer tracked
)

// ClientFrame is one browser-to-swarm stream frame. Type selects the verb,
// SessionID names the session it applies to.
type ClientFrame struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId,omitempty"`
}

// SessionState is one session's reconciled control state beside swarm-owned
// facts ajent never announces: the prompts parked for the next idle point.
type SessionState struct {
	ctl.State
	ParkedRows []ctl.QueueRow `json:"parkedRows,omitempty"` // oldest first, secrets redact to empty text
}

// InitFrame answers a subscribe or sync: the reconciled snapshot plus a
// bounded tail of committed entries, oldest first. Cursor is the id of the
// oldest entry included, empty when the retained history starts there.
// Receiving an init replaces everything the client holds for that session and
// resets its watermark: ajent renumbers seq from zero on each instance, so an
// init never merges into prior state.
type InitFrame struct {
	Type      string       `json:"type"`
	SessionID string       `json:"sessionId"`
	State     SessionState `json:"state"`
	Entries   []ctl.Entry  `json:"entries"`
	Cursor    string       `json:"cursor,omitempty"`
}

// EventFrame forwards one upstream event verbatim beside the session it
// belongs to, so a client applies it by the one watermark rule.
type EventFrame struct {
	Type      string    `json:"type"`
	SessionID string    `json:"sessionId"`
	Event     ctl.Event `json:"event"`
}

// ChildFrame synthesizes lifecycle facts only swarm knows: connection state,
// exit reasons and fleet removal. Detail carries the last transport error
// while degraded or the session's own exit reason when exited.
type ChildFrame struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	State     string `json:"state"`
	Detail    string `json:"detail,omitempty"`
}

// ErrorFrame reports a refused stream verb, the connection stays open.
// SessionID names the session the refusal applies to, empty for frame-level
// problems (bad JSON, unknown verbs) that name no session.
type ErrorFrame struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId,omitempty"`
	Code      string `json:"code"`
	Message   string `json:"message,omitempty"`
}

// HeartbeatFrame is the periodic liveness signal every open stream receives.
type HeartbeatFrame struct {
	Type string `json:"type"`
}
