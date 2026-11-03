// Package web serves the embedded frontend build: static assets at their
// paths, SPA routes falling back to index.html.
package web

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

//go:embed dist
var distFS embed.FS

const indexHTML = "index.html"

// assetsDir holds the Vite fingerprinted bundles; a content hash in every
// name means those responses can cache forever and never need revalidation.
const assetsDir = "assets/"

// The two cache classes: only /assets/ caches long-term, everything else
// must revalidate on every load so an upgraded binary wins on the next visit.
const (
	cacheRevalidate = "no-cache"
	cacheImmutable  = "public, max-age=31536000, immutable"
)

// contentSecurityPolicy guards the SPA document. The script hash pins the
// inline theme-bootstrap; web_test.go recomputes it from the embedded
// document so an edit to that script fails there first. unsafe-inline covers
// shiki's style attributes, data: and blob: cover base64 transcript images.
const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self' 'sha256-N+WpdPC/19S1AaS3IDTIP/kRunBN2eK8etr8xarLlU8='; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; " +
	"object-src 'none'; base-uri 'self'; frame-ancestors 'none'"

// Handler serves the embedded dist directory. A path without an extension
// that misses a file renders the SPA document; an asset miss stays 404 so a
// broken script reference is visible instead of silently parsing HTML.
func Handler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil { // unreachable for the embedded layout
		panic("web: embed dist missing: " + err.Error())
	}
	etag := documentETag(sub)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name == "" || name == indexHTML {
			// the root and a direct /index.html are document responses too
			serveDocument(w, r, sub, etag)
			return
		}
		f, err := sub.Open(name)
		if err != nil {
			if path.Ext(name) != "" {
				// no negative caching, a rebuild that adds the path back
				// must be honored immediately
				w.Header().Set("Cache-Control", cacheRevalidate)
				http.NotFound(w, r)
				return
			}
			serveDocument(w, r, sub, etag)
			return
		}
		defer func() { _ = f.Close() }()

		fi, err := f.Stat()
		if err == nil && fi.IsDir() {
			// directory hits are SPA routes in disguise (e.g. /sessions/)
			serveDocument(w, r, sub, etag)
			return
		}

		cache := cacheRevalidate
		if strings.HasPrefix(name, assetsDir) {
			cache = cacheImmutable
		}
		w.Header().Set("Cache-Control", cache)
		content := f.(io.ReadSeeker)
		http.ServeContent(w, r, path.Base(name), time.Time{}, content)
	})
}

// serveDocument serves the SPA document with its content security policy and
// revalidation headers. The etag pins the embedded bytes so conditional
// requests answer 304 until an upgraded binary changes the document.
func serveDocument(w http.ResponseWriter, r *http.Request, fsys fs.FS, etag string) {
	w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
	w.Header().Set("Cache-Control", cacheRevalidate)
	w.Header().Set("ETag", etag)
	f, err := fsys.Open(indexHTML)
	if err != nil { // only for a broken embed; index.html always exists
		http.NotFound(w, r)
		return
	}
	defer func() { _ = f.Close() }()
	content := f.(io.ReadSeeker)
	http.ServeContent(w, r, indexHTML, time.Time{}, content)
}

// documentETag returns the strong etag for the embedded document bytes;
// panics only for a broken embed, like the dist check in Handler.
func documentETag(fsys fs.FS) string {
	b, err := fs.ReadFile(fsys, indexHTML)
	if err != nil { // unreachable for the embedded layout
		panic("web: embed index.html missing: " + err.Error())
	}
	sum := sha256.Sum256(b)
	return `"` + hex.EncodeToString(sum[:]) + `"`
}
