package api

import (
	"crypto/rand"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// maxAttachmentBytes bounds one upload, vision models reject far larger
	// images, and the bytes land on local disk either way.
	maxAttachmentBytes = 20 << 20

	// attachmentExtMax bounds the sanitized extension so a hostile name
	// cannot stretch the stored path.
	attachmentExtMax = 16
)

// attachmentReply names where the bytes landed: an absolute path under
// swarm's state directory, ready to submit as an @<abs path> reference.
type attachmentReply struct {
	Path string `json:"path"`
}

// handleSessionAttachment stores one uploaded file for @-reference submits.
// The body is multipart/form-data with a single "file" field, bytes are kept
// verbatim under <state>/attachments/<session id>/.
func (s *apiServer) handleSessionAttachment(w http.ResponseWriter, r *http.Request) {
	sessionID := sanitizeAttachmentName(r.PathValue("id"))
	if sessionID == "" {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "session id must not be empty")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxAttachmentBytes)
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest,
			"expected multipart/form-data with a file field: "+err.Error())
		return
	}
	defer func() { _ = file.Close() }()

	dir := filepath.Join(s.attachmentsDir, sessionID)
	if err = os.MkdirAll(dir, 0o700); err != nil {
		writeError(w, http.StatusInternalServerError, codeInternalError, "")
		return
	}

	path := filepath.Join(dir, attachmentName(time.Now(), header.Filename))
	out, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternalError, "")
		return
	}
	_, copyErr := io.Copy(out, file) // a partial upload must not linger as usable
	closeErr := out.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(path)
		writeError(w, http.StatusInternalServerError, codeInternalError, "")
		return
	}

	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path // a relative answer still points at the same file
	}
	writeJSON(w, http.StatusCreated, attachmentReply{Path: abs})
}

// attachmentName builds the stored file name: a timestamp and random token
// keep concurrent uploads apart, only the extension survives from the client.
func attachmentName(now time.Time, original string) string {
	var b [8]byte
	rand.Read(b[:]) // crypto/rand never fails, nothing sensible to answer anyway
	name := now.UTC().Format("20060102-150405") + "-" + hex.EncodeToString(b[:])
	if ext := sanitizeAttachmentExt(filepath.Ext(original)); ext != "" {
		name += "." + ext
	}
	return name
}

// sanitizeAttachmentExt reduces a client-supplied extension to bare word
// characters, so only something like "png" survives and never a path.
func sanitizeAttachmentExt(ext string) string {
	ext = strings.TrimPrefix(strings.TrimSpace(ext), ".")
	if len(ext) > attachmentExtMax {
		ext = ext[:attachmentExtMax]
	}
	var b strings.Builder
	for _, r := range ext {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default: // drop anything path-like outright
		}
	}
	return b.String()
}

// sanitizeAttachmentName keeps one path element's safe characters. Separators,
// parent references and everything else reduce to the empty string.
func sanitizeAttachmentName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." {
		return ""
	}
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		case r == '.':
			if b.Len() > 0 { // an inner dot survives, a leading one never does
				b.WriteRune(r)
			}
		default: // drop anything path-like outright
		}
	}
	return strings.Trim(b.String(), ".-")
}
