package sched

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-analyze/bulk"

	"github.com/jentfoo/ajent-swarm/pkg/logrotate"
)

// pruneChildLogs removes captured child logs older than the retention cutoff.
// Live children keep appending, so their files stay fresh and survive, a log
// that vanished already is not an error. Directories are left alone.
func pruneChildLogs(dir string, cutoff time.Time, log *slog.Logger) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return // no children captured yet
	}
	stale := bulk.SliceFilter(func(e os.DirEntry) bool {
		if e.IsDir() || !isChildLog(e.Name()) {
			return false
		}
		info, err := e.Info()
		return err == nil && info.ModTime().Before(cutoff)
	}, entries)
	for _, e := range stale {
		path := filepath.Join(dir, e.Name())
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			log.Warn("child log not pruned", "path", path, "err", err)
		}
	}
}

// isChildLog reports whether name is a captured child log or one of its
// numbered archives (4242.log, 4242.log.1), so retention prunes both.
func isChildLog(name string) bool {
	base, rest, ok := strings.Cut(name, ".log")
	return ok && base != "" && strings.Trim(rest, ".0123456789") == ""
}

// RotateChildLogs copytruncates every child log past maxBytes, keeping
// maxBackups numbered archives each. Live children hold their log open in
// append mode, which copytruncate tolerates. A maxBytes of 0 or an absent
// directory does nothing.
func RotateChildLogs(dir string, maxBytes int64, maxBackups int, log *slog.Logger) {
	if maxBytes <= 0 {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return // no children captured yet
	}
	logs := bulk.SliceFilter(func(e os.DirEntry) bool {
		return strings.HasSuffix(e.Name(), ".log") && !e.IsDir()
	}, entries)
	for _, e := range logs {
		path := filepath.Join(dir, e.Name())
		if err := logrotate.TruncateRotate(path, maxBytes, maxBackups); err != nil {
			log.Warn("child log not rotated", "path", path, "err", err)
		}
	}
}
