package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/jentfoo/ajent-swarm/pkg/api"
	"github.com/jentfoo/ajent-swarm/pkg/auth"
	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	"github.com/jentfoo/ajent-swarm/pkg/sched"
	"github.com/jentfoo/ajent-swarm/pkg/store"
)

const (
	swarmDirName    = "swarm"       // default state dir beside ajent's own data
	logFileName     = "swarm.log"   // daemon log inside the state dir
	pidFileName     = "swarm.pid"   // pid file inside the state dir
	childrenDirName = "children"    // child logs inside the state dir
	attachDirName   = "attachments" // composer uploads referenced by @path
)

// serve resolves paths, locks the instance and runs until SIGINT or SIGTERM.
func serve(opts Options, stderr io.Writer) int {
	dir, warn, err := ensureStateDir(opts.StateDir)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "ajent-swarm: %v\n", err)
		return 1
	}

	log, closeLog := openLogger(opts, stderr)
	defer closeLog()
	if warn != "" {
		log.Warn("state directory permissions adjusted", "detail", warn)
	}
	fail := func(err error) int {
		notifyReady("error %v", err)
		log.Error("startup failed", "err", err)
		return 1
	}

	lock, err := acquireInstanceLock(dir)
	if err != nil {
		return fail(err)
	}
	defer func() { _ = lock.Close() }()

	pidPath := opts.Pidfile
	if pidPath == "" {
		pidPath = filepath.Join(dir, pidFileName)
	}
	if err = writePidfile(pidPath); err != nil {
		return fail(err)
	}
	defer removePidfile(pidPath)

	st, err := store.Open(filepath.Join(dir, store.FileName))
	if err != nil {
		return fail(err)
	}
	defer func() { _ = st.Close() }()

	ctx := context.Background()
	svc, err := auth.NewService(st)
	if err != nil {
		return fail(err)
	}

	username, err := currentUsername()
	if err != nil {
		return fail(err)
	}
	if err = svc.EnsureUser(ctx, username); err != nil {
		return fail(err)
	}
	if opts.Password != "" {
		if err = svc.SetPassword(ctx, opts.Password); err != nil {
			return fail(fmt.Errorf("--password: %w", err))
		}
		log.Info("login password updated from --password")
	}
	if _, err = st.DeleteExpiredSessions(ctx, time.Now()); err != nil {
		return fail(err)
	}

	bin, version, err := locateAjent(ctx, opts.AjentBin)
	if err != nil {
		return fail(err)
	}
	log.Info("ajent binary ready", "path", bin, "version", version)

	childrenDir := filepath.Join(dir, childrenDirName)
	fleetMgr := fleet.New(fleet.Options{
		Log:         log,
		AjentBin:    bin,
		ChildrenDir: childrenDir,
		ChildStore:  childStore{st: st},
		TitleStore:  titleStore{st: st},
		KillOnExit:  opts.KillChildren,
		NoNaming:    opts.NoSessionNaming,
	})
	fleetMgr.Start(ctx)
	defer fleetMgr.Stop()

	scheduler := sched.New(sched.Options{
		Log:           log,
		Store:         st,
		Runner:        fleetMgr,
		RetentionDays: opts.RunRetentionDays,
		RetentionMax:  opts.RunRetentionMax,
		ChildrenDir:   childrenDir,
	})
	scheduler.Start(ctx)
	defer scheduler.Stop() // stops before the fleet: no run launches into teardown

	handler := api.Handler(api.Config{
		Auth:                 svc,
		Fleet:                fleetMgr,
		Sched:                scheduler,
		AttachmentsDir:       filepath.Join(dir, attachDirName),
		AllowRemoteBootstrap: opts.AllowRemoteBootstrap,
		Log:                  log,
	})
	srv := api.NewServer(handler)

	addr := net.JoinHostPort(opts.Host, strconv.Itoa(opts.Port))
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", addr)
	if err != nil {
		return fail(fmt.Errorf("bind %s: %w", addr, err))
	}
	log.Info("ajent-swarm listening", "addr", addr, "state", dir)

	notifyReady("ok")
	return runUntilSignal(srv, ln, log)
}

// runUntilSignal serves until SIGINT or SIGTERM and drains under api.Serve's
// bounded wait. A second signal falls back to default handling once the first
// is consumed, terminating the process immediately.
func runUntilSignal(srv *http.Server, ln net.Listener, log *slog.Logger) int {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(sigs)

	serveErr := make(chan error, 1)
	go func() { serveErr <- api.Serve(ctx, srv, ln, log) }()

	select {
	case err := <-serveErr:
		log.Error("server stopped unexpectedly", "err", err)
		return 1
	case sig := <-sigs:
		signal.Stop(sigs)
		log.Info("shutting down", "signal", sig.String())
		cancel()
		if err := <-serveErr; err != nil {
			log.Error("shutdown failed", "err", err)
			return 1
		}
		log.Info("shutdown complete")
		return 0
	}
}

// openLogger builds the process logger: an explicit log path in the
// foreground, otherwise stderr. A daemon child always writes stderr because
// its parent already redirected it into the log file.
func openLogger(opts Options, stderr io.Writer) (*slog.Logger, func()) {
	sink := stderr
	var file *os.File
	if !isDaemonChild() && opts.LogPath != "" {
		of, err := os.OpenFile(opts.LogPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err == nil {
			sink = of
			file = of
		} else {
			_, _ = fmt.Fprintf(stderr, "ajent-swarm: open --log %s: %v (falling back to stderr)\n",
				opts.LogPath, err)
		}
	}
	log := slog.New(slog.NewTextHandler(sink, nil))
	return log, func() {
		if file != nil {
			_ = file.Close()
		}
	}
}

// currentUsername returns the unix account running the service.
func currentUsername() (string, error) {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username, nil
	}
	if name := os.Getenv("USER"); name != "" {
		return name, nil // fallback for environments where os/user fails
	}
	return "", errors.New("cannot determine the current unix user")
}
