package main

import (
	"testing"

	"github.com/spf13/pflag"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseFlags(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		argv    []string
		want    int
		wantErr string
	}{
		{name: "default port", argv: nil, want: defaultPort},
		{name: "explicit port", argv: []string{"--port", "9000"}, want: 9000},
		{name: "equals form", argv: []string{"--port=1234"}, want: 1234},
		{name: "min bound", argv: []string{"--port", "1"}, want: minPort},
		{name: "max bound", argv: []string{"--port", "65535"}, want: maxPort},
		{name: "not a number", argv: []string{"--port", "http"}, wantErr: `invalid argument "http" for "--port" flag`},
		{name: "missing value", argv: []string{"--port"}, wantErr: "flag needs an argument"},
		{name: "unknown flag", argv: []string{"--nope"}, wantErr: "unknown flag: --nope"},
		{name: "help requested", argv: []string{"--help"}, wantErr: pflag.ErrHelp.Error()},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f, err := parseFlags(tt.argv)
			if tt.wantErr != "" {
				assert.ErrorContains(t, err, tt.wantErr)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tt.want, f.port)
		})
	}
}

func TestValidate(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		port    int
		wantErr string
	}{
		{name: "default port", port: defaultPort},
		{name: "min bound", port: minPort},
		{name: "max bound", port: maxPort},
		{name: "zero port", port: 0, wantErr: "--port must be between 1 and 65535, not 0"},
		{name: "negative port", port: -1, wantErr: "--port must be between 1 and 65535, not -1"},
		{name: "above max", port: maxPort + 1, wantErr: "--port must be between 1 and 65535, not 65536"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := cliFlags{port: tt.port}.validate()
			if tt.wantErr != "" {
				assert.EqualError(t, err, tt.wantErr)
				return
			}
			assert.NoError(t, err)
		})
	}
}
