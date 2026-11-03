package main

import (
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/spf13/pflag"

	"github.com/jentfoo/ajent-swarm/pkg/app"
)

// exitUsage is the shell convention for misuse, kept apart from a runtime failure.
const exitUsage = 2

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run parses argv and starts the service, returning the process exit code.
// The stop and status subcommands run first: they operate on an already-
// running instance and read only the pid file.
func run(argv []string, stdout, stderr io.Writer) int {
	if len(argv) > 0 {
		switch argv[0] {
		case cmdStop:
			return lifecycleRun(cmdStop, app.Stop, argv[1:], stdout, stderr)
		case cmdStatus:
			return lifecycleRun(cmdStatus, app.Status, argv[1:], stdout, stderr)
		}
	}

	f, err := parseFlags(argv)
	if errors.Is(err, pflag.ErrHelp) {
		return 0 // help already printed; exit cleanly
	} else if err != nil {
		_, _ = fmt.Fprintf(stderr, "ajent-swarm: %v\n", err)
		return exitUsage
	}
	if verr := f.validate(); verr != nil {
		_, _ = fmt.Fprintf(stderr, "ajent-swarm: %v\n", verr)
		return exitUsage
	}

	return app.Run(app.Options{
		Port:                 f.port,
		Host:                 f.host,
		StateDir:             f.state,
		Password:             f.password,
		Daemon:               f.daemon,
		Pidfile:              f.pidfile,
		LogPath:              f.logPath,
		AjentBin:             f.ajentBin,
		AllowRemoteBootstrap: f.allowRemoteBootstrap,
		KillChildren:         f.killChildren,
		NoSessionNaming:      f.noNaming,
		RunRetentionDays:     f.runRetentionDays,
		RunRetentionMax:      f.runRetentionMax,
		LogMaxBytes:          int64(f.logMaxMB) << 20,
		LogBackups:           f.logBackups,
	}, argv, stdout, stderr)
}
