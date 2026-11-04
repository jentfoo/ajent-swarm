package fleet

import (
	"context"
	"os"
	"path/filepath"
	"strings"
)

// filesMax bounds one completion answer; a prefix matching more entries than
// this simply truncates, and typing another character narrows it.
const filesMax = 50

// FileSuggestion is one @-completion candidate: the replacement path fragment
// to drop into the composer token, directories marked so clients can style
// them (the fragment already carries its trailing separator).
type FileSuggestion struct {
	Path string `json:"path"`
	Dir  bool   `json:"dir,omitempty"`
}

// Files answers composer @-completion for one session: entries of the query's
// directory whose name matches its last segment, resolved against the
// session's working directory unless the query is absolute. A trailing
// separator completes inside the named directory; a leading ~ expands to the
// service home. An unreadable or missing directory answers empty: completion
// stays silent rather than erroring in the composer.
func (m *Manager) Files(ctx context.Context, sessionID string, query string) ([]FileSuggestion, error) {
	snap, err := m.Snapshot(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	cwd := snap.Cwd
	if cwd == "" {
		cwd = snap.Workspace
	}

	query = strings.TrimSpace(query)
	dir, base, relPrefix := splitQuery(cwd, query)

	dirents, err := os.ReadDir(dir)
	if err != nil {
		return []FileSuggestion{}, nil
	}

	items := make([]FileSuggestion, 0, min(filesMax, len(dirents)))
	lower := strings.ToLower(base)
	for _, de := range dirents {
		name := de.Name()
		if !strings.HasPrefix(strings.ToLower(name), lower) {
			continue
		}
		if strings.HasPrefix(name, ".") && !strings.HasPrefix(base, ".") {
			continue // hidden entries surface only when asked for
		}
		fragment := relPrefix + name
		dirLike := de.IsDir() || de.Type()&os.ModeSymlink != 0 && isDir(filepath.Join(dir, name))
		if dirLike {
			fragment += "/"
		}
		items = append(items, FileSuggestion{Path: fragment, Dir: dirLike})
		if len(items) >= filesMax {
			break
		}
	}
	return items, nil
}

// splitQuery resolves a completion query against the session cwd: it returns
// the directory to list, the (possibly empty) name prefix to match, and the
// typed prefix a suggestion should keep in its replacement fragment.
func splitQuery(cwd, query string) (dir, base, relPrefix string) {
	home, _ := os.UserHomeDir()
	if home != "" && strings.HasPrefix(query, "~") &&
		(len(query) == 1 || query[1] == '/') {
		query = home + strings.TrimPrefix(query, "~")
	}

	endsSep := strings.HasSuffix(query, "/")
	var typed string // the directory part as typed, kept in every fragment
	if endsSep {
		typed = query
	} else if i := strings.LastIndex(query, "/"); i >= 0 {
		typed = query[:i+1]
	}

	dir = cwd
	if query == "" {
		return dir, "", ""
	}
	if strings.HasPrefix(query, "/") { // absolute (the ~ form expanded above)
		dir = filepath.Dir(filepath.Clean(query))
	} else if typed != "" {
		dir = filepath.Join(cwd, typed)
	}
	if !endsSep {
		base = strings.ToLower(filepath.Base(strings.TrimSuffix(query, "/")))
	}
	return dir, base, typed
}

// isDir reports whether path resolves to a directory.
func isDir(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.IsDir()
}
