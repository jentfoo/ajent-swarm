package main

import (
	"errors"
	"fmt"
	"os"

	"github.com/spf13/pflag"
)

// exitUsage is the shell convention for misuse, kept apart from a runtime failure.
const exitUsage = 2

func main() {
	f, err := parseFlags(os.Args[1:])
	if errors.Is(err, pflag.ErrHelp) {
		return // help already printed; exit cleanly
	} else if err != nil {
		fmt.Fprintf(os.Stderr, "ajent-swarm: %v\n", err)
		os.Exit(exitUsage)
	}
	if verr := f.validate(); verr != nil {
		fmt.Fprintf(os.Stderr, "ajent-swarm: %v\n", verr)
		os.Exit(exitUsage)
	}

	// TODO: bind the control API once it lands, for now only report the parsed port
	fmt.Printf("ajent-swarm: would bind :%d\n", f.port)
}
