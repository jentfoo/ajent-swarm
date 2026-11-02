package main

import (
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/pflag"
)

// defaultPort is the bind port when --port is not given.
const defaultPort = 8282

// ports below minPort or above maxPort cannot be bound, so they are usage errors
// rather than something the OS gets to discover at listen time.
const (
	minPort = 1
	maxPort = 65535
)

// cliFlags is one parsed command line. Empty state, pidfile and log paths
// resolve to defaults under the ajent home at startup.
type cliFlags struct {
	port                 int    // --port: TCP port the control API binds
	host                 string // --host: bind address, loopback by default
	state                string // --state: state directory override
	password             string // --password: seed or replace the login password
	daemon               bool   // --daemon: run detached in the background
	pidfile              string // --pidfile: pid file path override
	logPath              string // --log: log file path override
	ajentBin             string // --ajent-bin: ajent binary path override
	allowRemoteBootstrap bool   // --allow-remote-bootstrap: non-loopback may set the first password
	killChildren         bool   // --kill-children-on-shutdown: take spawned children down at exit
	noNaming             bool   // --no-naming: never auto-name sessions from their first prompt
	runRetentionDays     int    // --run-retention-days: prune run history older than this
	runRetentionMax      int    // --run-retention-max: cap on stored run rows

	passwordGiven bool // --password appeared, so an empty value is a usage error
}

// parseFlags parses argv (without the program name) into the command line. It
// reports pflag.ErrHelp when usage was requested and printed.
func parseFlags(argv []string) (cliFlags, error) {
	var f cliFlags

	fs := pflag.NewFlagSet("ajent-swarm", pflag.ContinueOnError)
	fs.IntVar(&f.port, "port", defaultPort, "TCP port to bind the control API on")
	fs.StringVar(&f.host, "host", "127.0.0.1", "address to bind; use 0.0.0.0 for LAN access")
	fs.StringVar(&f.state, "state", "", "state directory (default <ajent home>/swarm)")
	fs.StringVar(&f.password, "password", "",
		"set the login password at startup, replacing any previous one")
	fs.BoolVar(&f.daemon, "daemon", false, "run detached in the background, logging to a file")
	fs.StringVar(&f.pidfile, "pidfile", "", "pid file path (default <state>/swarm.pid)")
	fs.StringVar(&f.logPath, "log", "",
		"log file path (daemon default <state>/swarm.log; foreground logs to stderr)")
	fs.StringVar(&f.ajentBin, "ajent-bin", "",
		"path to the ajent binary (default resolved from PATH)")
	fs.BoolVar(&f.allowRemoteBootstrap, "allow-remote-bootstrap", false,
		"let a non-loopback peer set the first password")
	fs.BoolVar(&f.killChildren, "kill-children-on-shutdown", false,
		"terminate sessions swarm spawned when the service exits (default: they outlive it)")
	fs.BoolVar(&f.noNaming, "no-naming", false,
		"skip auto-naming unnamed sessions from their first prompt")
	fs.IntVar(&f.runRetentionDays, "run-retention-days", 30,
		"prune scheduled-run history and child logs older than this many days (0 keeps forever)")
	fs.IntVar(&f.runRetentionMax, "run-retention-max", 10000,
		"keep at most this many run rows of history (0 keeps unlimited)")

	if err := fs.Parse(argv); err != nil {
		return f, err
	}
	f.passwordGiven = fs.Changed("password")
	return f, nil
}

// validate reports the first usage error in the parsed command line.
func (f cliFlags) validate() error {
	if f.port < minPort || f.port > maxPort {
		return fmt.Errorf("--port must be between %d and %d, not %d", minPort, maxPort, f.port)
	}
	if f.passwordGiven && strings.TrimSpace(f.password) == "" {
		return errors.New("--password must not be empty")
	}
	if f.runRetentionDays < 0 {
		return errors.New("--run-retention-days must not be negative")
	}
	if f.runRetentionMax < 0 {
		return errors.New("--run-retention-max must not be negative")
	}
	return nil
}
