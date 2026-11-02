package fleet

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jentfoo/ajent/pkg/llm"
	"github.com/jentfoo/ajent/pkg/session"
)

// Kinds of rewirable entries, matching what session.rewind does with each
// target: a user prompt rewinds to its parent so the prompt re-sends, an
// assistant reply keeps itself in the restored branch, and a compaction moves
// to its parent. Anything else upstream refuses.
const (
	CandidateUser       = "user"
	CandidateAssistant  = "assistant"
	CandidateCompaction = "compaction"

	// candidateLabelMax caps each label so the picker feed stays list-sized;
	// full bodies stay on the entries endpoints.
	candidateLabelMax = 160
)

// RewindCandidate is one rewirable entry in the transcript tree, every fork
// included, ready to pass as a rewind head.
type RewindCandidate struct {
	ID       string `json:"id"`
	ParentID string `json:"parentId,omitempty"`
	Kind     string `json:"kind"`
	TS       int64  `json:"ts"` // unix milliseconds
	Label    string `json:"label,omitempty"`
	IsHead   bool   `json:"isHead"`
}

// RewindCandidates answers the rewind picker: the live head beside every fork
// candidate, so a browser never needs the whole entry set to offer one.
type RewindCandidates struct {
	Head       string            `json:"head"`
	Candidates []RewindCandidate `json:"candidates"`
}

type msgRewindSource struct{ reply chan rewindSource }

// Candidates derives the rewind picker for one session: its transcript tree,
// read fresh, classified against the head the live snapshot reports.
func (m *Manager) Candidates(ctx context.Context, sessionID string) (RewindCandidates, error) {
	a := m.route(sessionID)
	if a == nil {
		return RewindCandidates{}, ErrUnknownSession
	}
	src, err := mailboxCall(ctx, a, func(reply chan rewindSource) actorMsg {
		return msgRewindSource{reply: reply}
	})
	if err != nil {
		return RewindCandidates{}, err
	}
	if !src.ok {
		return RewindCandidates{}, notReady()
	}
	if src.path == "" { // serve mode always records, so this is a broken hello
		return RewindCandidates{}, errors.New("session recording is off: no transcript to read")
	}

	entries, _, err := session.Read(src.path)
	if err != nil {
		return RewindCandidates{}, fmt.Errorf("reading transcript: %w", err)
	}
	return rewindCandidates(entries, src.head), nil
}

// rewindCandidates classifies a transcript tree's rewirable entries in file
// order, which is creation order for the append-only JSONL.
func rewindCandidates(entries []session.Entry, head string) RewindCandidates {
	out := RewindCandidates{Head: head, Candidates: []RewindCandidate{}}
	for _, e := range entries {
		var kind, label string
		switch e.Type {
		case session.TypeMessage:
			var md session.MessageData
			if err := e.Decode(&md); err != nil {
				continue
			}
			switch {
			case isUserPrompt(md):
				kind = CandidateUser
				label = llm.JoinText(md.Message.Content)
			case md.Message.Role == llm.RoleAssistant:
				kind = CandidateAssistant
				label = llm.JoinText(md.Message.Content)
			default: // tool-result plumbing and injected context never re-send
				continue
			}
		case session.TypeCompaction:
			var cd session.CompactionData
			if err := e.Decode(&cd); err != nil {
				continue
			}
			kind = CandidateCompaction
			label = cd.Summary
		default: // notices, model changes and the like refuse upstream anyway
			continue
		}

		out.Candidates = append(out.Candidates, RewindCandidate{
			ID:       e.ID,
			ParentID: e.ParentID,
			Kind:     kind,
			TS:       e.TS,
			Label:    truncateLabel(label),
			IsHead:   e.ID == head,
		})
	}
	return out
}

// isUserPrompt applies ajent's own prompt classification: typed user text,
// not system-injected, not a tool-result carrier.
func isUserPrompt(md session.MessageData) bool {
	return md.Message.Role == llm.RoleUser && !md.Injected &&
		!llm.OnlyToolResults(md.Message.Content)
}

// truncateLabel keeps labels picker-sized: one line and at most
// candidateLabelMax runes counting the ellipsis.
func truncateLabel(s string) string {
	s = strings.TrimSpace(s)
	runes := []rune(s)
	if len(runes) <= candidateLabelMax {
		return s
	}
	return string(runes[:candidateLabelMax-1]) + "…"
}
