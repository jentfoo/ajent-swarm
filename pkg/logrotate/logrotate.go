// Package logrotate provides size-capped rotation for service logs: a
// rotating io.Writer for files this process owns, and a copytruncate rotation
// for files another process holds open in append mode, like ajent child logs.
package logrotate

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"sync"
)

// ErrClosed reports a Write attempt after Close.
var ErrClosed = errors.New("log writer is closed")

// Writer is an append-mode io.Writer that rotates its file once a write would
// push it past max bytes, keeping at most backups numbered archives beside it
// (path.1 newest .. path.N oldest). max of 0 disables rotation.
type Writer struct {
	mu      sync.Mutex
	path    string
	max     int64 // rotate when a write would push size past this, 0 disables
	backups int   // archives kept besides the live file
	file    *os.File
	size    int64 // current live file size, tracked to avoid a stat per write
}

// NewWriter opens path for appending, creating it when missing.
func NewWriter(path string, maxBytes int64, backups int) (*Writer, error) {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open log %s: %w", path, err)
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("stat log %s: %w", path, err)
	}
	return &Writer{
		path:    path,
		max:     maxBytes,
		backups: backups,
		file:    f,
		size:    info.Size(),
	}, nil
}

// Write appends p, rotating first when the cap would be crossed.
func (w *Writer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return 0, ErrClosed
	}
	if w.max > 0 && w.size+int64(len(p)) > w.max {
		if err := w.rotateLocked(); err != nil {
			return 0, err
		}
	}
	n, err := w.file.Write(p)
	w.size += int64(n)
	return n, err
}

// Close releases the file.
func (w *Writer) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}

// rotateLocked shifts the archives, moves the live file to path.1 and reopens
// a fresh one. A failed reopen surfaces to the caller instead of silently
// dropping logs.
func (w *Writer) rotateLocked() error {
	if err := w.file.Close(); err != nil {
		return fmt.Errorf("close log %s: %w", w.path, err)
	}
	if err := shiftArchives(w.path, w.backups); err != nil {
		return err
	}
	if err := os.Rename(w.path, archivePath(w.path, 1)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("rotate log %s: %w", w.path, err)
	}
	f, err := os.OpenFile(w.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		w.file = nil
		return fmt.Errorf("reopen log %s: %w", w.path, err)
	}
	w.file = f
	w.size = 0
	return nil
}

// TruncateRotate copytruncates path once it exceeds maxBytes: content moves to
// path.1, older archives shift, at most backups are kept, then the live file
// is truncated to zero. Truncation stays safe for writers holding the file
// open in append mode, which is how child logs are inherited, writes landing
// in the copy-to-truncate window are lost, which is acceptable for captured
// process output. A missing or under-cap file is not an error.
func TruncateRotate(path string, maxBytes int64, backups int) error {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("stat log %s: %w", path, err)
	}
	if maxBytes <= 0 || info.Size() <= maxBytes {
		return nil
	}
	// no archive slots: just truncate, losing the over-cap content
	if backups > 0 {
		if err = shiftArchives(path, backups); err != nil {
			return err
		}
		if err = copyFile(path, archivePath(path, 1)); err != nil {
			return err
		}
	}
	if err = os.Truncate(path, 0); err != nil {
		return fmt.Errorf("truncate log %s: %w", path, err)
	}
	return nil
}

// archivePath names the nth archive of path.
func archivePath(path string, n int) string {
	return path + "." + strconv.Itoa(n)
}

// shiftArchives drops the oldest archive and moves each remaining one up a
// slot, leaving archive slot 1 free for the current file. Missing archives are
// skipped.
func shiftArchives(path string, backups int) error {
	if backups <= 0 {
		return nil
	}
	for i := backups - 1; i >= 1; i-- {
		from, to := archivePath(path, i), archivePath(path, i+1)
		if err := os.Rename(from, to); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("shift log archives %s: %w", path, err)
		}
	}
	return nil
}

// copyFile copies src to a fresh dst, refusing to clobber an existing one.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("copy log %s: %w", src, err)
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("copy log %s: %w", dst, err)
	}
	if _, err = io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(dst)
		return fmt.Errorf("copy log %s: %w", src, err)
	}
	if err = out.Close(); err != nil {
		_ = os.Remove(dst)
		return fmt.Errorf("close copy %s: %w", dst, err)
	}
	return nil
}
