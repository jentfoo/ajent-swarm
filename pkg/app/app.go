// Package app runs the ajent-swarm service: startup wiring and shutdown, the
// --daemon handoff, single-instance locking and ajent binary discovery.
package app

import "io"

// Options carries one parsed command line into the runtime. Empty StateDir,
// Pidfile, LogPath and AjentBin resolve to their defaults at startup.
type Options struct {
	Port                 int    // TCP port the control API binds
	Host                 string // bind address
	StateDir             string // state directory override
	Password             string // login password seed or replacement
	Daemon               bool   // run detached in the background
	Pidfile              string // pid file path override
	LogPath              string // log file path override
	AjentBin             string // ajent binary override
	AllowRemoteBootstrap bool   // non-loopback peers may set the first password
}

// Run starts the service and returns the process exit code. With Daemon set it
// spawns a detached copy of argv and waits only for its startup outcome;
// otherwise it serves in the foreground until SIGINT or SIGTERM.
func Run(opts Options, argv []string, stdout, stderr io.Writer) int {
	if opts.Daemon && !isDaemonChild() {
		return daemonize(opts, argv, stdout, stderr)
	}
	return serve(opts, stderr)
}
