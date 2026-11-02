package sched

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-analyze/bulk"
)

// pruneChildLogs removes captured child logs older than the retention cutoff.
// Live children keep appending, so their files stay fresh and survive; a log
// that vanished already is not an error. Directories are left alone.
func pruneChildLogs(dir string, cutoff time.Time, log *slog.Logger) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return // no children captured yet
	}
	stale := bulk.SliceFilter(func(e os.DirEntry) bool {
		if !strings.HasSuffix(e.Name(), ".log") || e.IsDir() {
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
