package main

import (
	"fmt"

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

// cliFlags is one parsed command line.
type cliFlags struct {
	port int // --port: TCP port the control API binds
}

// parseFlags parses argv (without the program name) into the command line. It
// reports pflag.ErrHelp when usage was requested and printed.
func parseFlags(argv []string) (cliFlags, error) {
	var f cliFlags

	fs := pflag.NewFlagSet("ajent-swarm", pflag.ContinueOnError)
	fs.IntVar(&f.port, "port", defaultPort, "TCP port to bind the control API on")

	if err := fs.Parse(argv); err != nil {
		return f, err
	}
	return f, nil
}

// validate reports the first usage error in the parsed command line.
func (f cliFlags) validate() error {
	if f.port < minPort || f.port > maxPort {
		return fmt.Errorf("--port must be between %d and %d, not %d", minPort, maxPort, f.port)
	}
	return nil
}
