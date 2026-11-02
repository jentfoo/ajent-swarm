// Package auth implements swarm's single-user credential model: the unix user
// plus one bcrypt password seeded by bootstrap or --password, cookie sessions
// with sliding expiry, hashed bearer API tokens and the bootstrap gate.
package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/jentfoo/ajent-swarm/pkg/store"
)

const (
	// SessionCookieName is the cookie carrying the raw session token.
	SessionCookieName = "swarm_session"
	// BootstrapPath is the one endpoint reachable before a password exists.
	BootstrapPath = "/api/auth/bootstrap"

	tokenPrefix = "swt_"
	secretLen   = 32

	defaultTTL   = 7 * 24 * time.Hour
	defaultSlide = time.Hour
)

// productionBcryptCost balances hash strength against login latency.
const productionBcryptCost = 12

// Via names how a principal authenticated.
const (
	ViaCookie = "cookie"
	ViaToken  = "token"
)

var (
	// ErrInvalidCredentials reports a failed login.
	ErrInvalidCredentials = errors.New("invalid credentials")
	// ErrInvalidSession reports an unknown or expired credential.
	ErrInvalidSession = errors.New("invalid session")
	// ErrAlreadyBootstrapped reports a bootstrap attempt past the first one.
	ErrAlreadyBootstrapped = errors.New("password already set")
	// ErrTokenNameTaken reports a token create with a used name.
	ErrTokenNameTaken = errors.New("token name already taken")
)

// Principal is the authenticated caller attached to request contexts.
type Principal struct {
	Username string // the single unix user
	Via      string // one of the Via constants
}

type principalCtxKey struct{}

// WithPrincipal attaches an authenticated principal to a context.
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalCtxKey{}, p)
}

// PrincipalFrom returns the request's authenticated principal when present.
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalCtxKey{}).(Principal)
	return p, ok
}

// Service is the auth state machine over the store. The bootstrap flag is
// one-way: once a usable credential exists it stays set for the process
// lifetime, so restart re-reads it from the database.
type Service struct {
	st           *store.Store
	username     string // the single user, from the unix account
	bootstrapped bool   // a usable password hash exists
	now          func() time.Time
	ttl          time.Duration // session lifetime, refreshed on slide
	slideEvery   time.Duration // minimum gap between expiry slides
	bcryptCost   int           // hashing work factor, 12 in production
}

// Option customizes the service, mainly for tests.
type Option func(*Service)

// WithClock replaces the wall clock.
func WithClock(now func() time.Time) Option {
	return func(s *Service) { s.now = now }
}

// WithSessionTTL sets both the session lifetime and the slide interval.
func WithSessionTTL(ttl, slideEvery time.Duration) Option {
	return func(s *Service) { s.ttl, s.slideEvery = ttl, slideEvery }
}

// WithBcryptCost overrides the hashing work factor; tests use it to skip the
// production cost's latency.
func WithBcryptCost(cost int) Option {
	return func(s *Service) { s.bcryptCost = cost }
}

// NewService reads credential state from an opened store.
func NewService(st *store.Store, opts ...Option) (*Service, error) {
	var s Service
	s.st = st
	s.now = time.Now
	s.ttl = defaultTTL
	s.slideEvery = defaultSlide
	s.bcryptCost = productionBcryptCost
	for _, opt := range opts {
		opt(&s)
	}

	ok, err := st.HasUsableCredential(context.Background())
	if err != nil {
		return nil, fmt.Errorf("read credential state: %w", err)
	}
	s.bootstrapped = ok
	u, err := st.SoleUser(context.Background())
	switch {
	case errors.Is(err, store.ErrNotFound): // not seeded yet; EnsureUser runs next
	case err != nil:
		return nil, fmt.Errorf("read sole user: %w", err)
	default:
		s.username = u.Username
	}
	return &s, nil
}

// BootstrapRequired reports whether no usable password exists yet.
func (s *Service) BootstrapRequired() bool {
	return !s.bootstrapped
}

// EnsureUser seeds the users row from the current unix username on first
// start. An existing row stays authoritative so a changed uid never resets
// the password behind the operator's back.
func (s *Service) EnsureUser(ctx context.Context, username string) error {
	u, err := s.st.SoleUser(ctx)
	switch {
	case errors.Is(err, store.ErrNotFound):
		if err = s.st.UpsertUserPassword(ctx, username, ""); err != nil {
			return err
		}
		s.username = username
		return nil
	case err != nil:
		return err
	default:
		s.username = u.Username
		return nil
	}
}

// SetPassword writes a fresh bcrypt hash for the seeded user. It upserts,
// which is what --password needs for headless setups.
func (s *Service) SetPassword(ctx context.Context, password string) error {
	if s.username == "" {
		return errors.New("no user row; seed one before setting a password")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), s.bcryptCost)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	if err = s.st.UpsertUserPassword(ctx, s.username, string(hash)); err != nil {
		return err
	}
	s.bootstrapped = true
	return nil
}

// Bootstrap sets the first password and refuses any later attempt.
func (s *Service) Bootstrap(ctx context.Context, password string) error {
	if !s.BootstrapRequired() {
		return ErrAlreadyBootstrapped
	}
	return s.SetPassword(ctx, password)
}
