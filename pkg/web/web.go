// Package web serves the embedded frontend build: static assets at their
// paths, SPA routes falling back to index.html.
package web

import (
	"embed"
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

// Handler serves the embedded dist directory. A path without an extension
// that misses a file renders the SPA document; an asset miss stays 404 so a
// broken script reference is visible instead of silently parsing HTML.
func Handler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil { // unreachable for the embedded layout
		panic("web: embed dist missing: " + err.Error())
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name == "" || name == "." {
			name = indexHTML
		}
		f, err := sub.Open(name)
		if err != nil {
			if path.Ext(name) != "" {
				http.NotFound(w, r)
				return
			}
			serveName(w, r, sub, indexHTML)
			return
		}
		defer func() { _ = f.Close() }()

		fi, err := f.Stat()
		if err == nil && fi.IsDir() {
			// directory hits are SPA routes in disguise (e.g. /sessions/)
			serveName(w, r, sub, indexHTML)
			return
		}

		content := f.(io.ReadSeeker)
		http.ServeContent(w, r, path.Base(name), time.Time{}, content)
	})
}

// serveName streams one fixed file from the embedded filesystem.
func serveName(w http.ResponseWriter, r *http.Request, fsys fs.FS, name string) {
	f, err := fsys.Open(name)
	if err != nil { // only for a broken embed; index.html always exists
		http.NotFound(w, r)
		return
	}
	defer func() { _ = f.Close() }()
	content := f.(io.ReadSeeker)
	http.ServeContent(w, r, path.Base(name), time.Time{}, content)
}
