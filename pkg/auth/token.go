package auth

import (
	"context"
	"errors"
	"fmt"
	"regexp"

	"github.com/jentfoo/ajent-swarm/pkg/store"
)

// tokenNamePattern keeps names URL-safe, since DELETE addresses them by name.
var tokenNamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// ValidateTokenName reports whether a token name is acceptable.
func ValidateTokenName(name string) error {
	if !tokenNamePattern.MatchString(name) {
		return errors.New("token names are 1-64 characters of letters, digits, dot, underscore or dash")
	}
	return nil
}

// CreateToken mints a bearer API token and returns its plaintext secret,
// which the service never stores in recoverable form.
func (s *Service) CreateToken(ctx context.Context, name string) (string, error) {
	if err := ValidateTokenName(name); err != nil {
		return "", err
	}
	raw, err := newSecret()
	if err != nil {
		return "", err
	}
	secret := tokenPrefix + raw
	tok := store.APIToken{
		Name:      name,
		TokenHash: hashSecret(secret),
		CreatedAt: s.now(),
	}
	if err = s.st.CreateAPIToken(ctx, tok); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return "", fmt.Errorf("%w: %q", ErrTokenNameTaken, name)
		}
		return "", err
	}
	return secret, nil
}

// Tokens lists every API token without its secrets.
func (s *Service) Tokens(ctx context.Context) ([]store.APIToken, error) {
	return s.st.Tokens(ctx)
}

// DeleteToken revokes one token by name and reports whether it existed.
func (s *Service) DeleteToken(ctx context.Context, name string) (bool, error) {
	if err := ValidateTokenName(name); err != nil {
		return false, err
	}
	return s.st.DeleteAPIToken(ctx, name)
}

// Bearer validates a plaintext API token secret. Usage timestamps refresh on
// the same cadence as session slides to avoid a write per request.
func (s *Service) Bearer(ctx context.Context, raw string) (Principal, error) {
	tok, err := s.st.APITokenByHash(ctx, hashSecret(raw))
	if errors.Is(err, store.ErrNotFound) {
		return Principal{}, ErrInvalidSession
	} else if err != nil {
		return Principal{}, err
	}

	now := s.now()
	if tok.LastUsed.IsZero() || now.Sub(tok.LastUsed) >= s.slideEvery {
		err = s.st.TouchTokenUsage(ctx, tok.TokenHash, now)
		if err != nil {
			return Principal{}, err
		}
	}
	return Principal{Username: s.username, Via: ViaToken}, nil
}
