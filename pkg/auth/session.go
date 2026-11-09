package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"

	"golang.org/x/crypto/bcrypt"

	"github.com/jentfoo/ajent-swarm/pkg/store"
)

// Login verifies the username and password, then issues a fresh opaque
// session token for its cookie.
func (s *Service) Login(ctx context.Context, username, password string) (string, error) {
	u, err := s.st.User(ctx, username)
	if errors.Is(err, store.ErrNotFound) {
		return "", ErrInvalidCredentials
	} else if err != nil {
		return "", err
	}
	// empty hash: never bootstrapped, bcrypt would reject it anyway
	if u.PasswordHash == "" || bcrypt.CompareHashAndPassword(
		[]byte(u.PasswordHash), []byte(password)) != nil {
		return "", ErrInvalidCredentials
	}

	raw, err := newSecret()
	if err != nil {
		return "", err
	}
	now := s.now()
	sess := store.AuthSession{
		TokenHash: hashSecret(raw),
		CreatedAt: now,
		LastSeen:  now,
		ExpiresAt: now.Add(s.ttl),
	}
	if err = s.st.CreateAuthSession(ctx, sess); err != nil {
		return "", err
	}
	return raw, nil
}

// Logout removes one session by its raw token.
func (s *Service) Logout(ctx context.Context, token string) error {
	return s.st.DeleteAuthSession(ctx, hashSecret(token))
}

// Session validates a cookie token and slides its expiry when due. A true
// second return asks the caller to re-issue the session cookie so an active
// browser keeps it alive past the original Max-Age.
func (s *Service) Session(ctx context.Context, token string) (Principal, bool, error) {
	if token == "" {
		return Principal{}, false, ErrInvalidSession
	}
	sess, err := s.st.AuthSessionByHash(ctx, hashSecret(token))
	if errors.Is(err, store.ErrNotFound) {
		return Principal{}, false, ErrInvalidSession
	} else if err != nil {
		return Principal{}, false, err
	}

	now := s.now()
	if !now.Before(sess.ExpiresAt) {
		_ = s.st.DeleteAuthSession(ctx, sess.TokenHash)
		return Principal{}, false, ErrInvalidSession
	}
	renewed := false
	if now.Sub(sess.LastSeen) >= s.slideEvery {
		err = s.st.TouchAuthSession(ctx, sess.TokenHash, now, now.Add(s.ttl))
		if err != nil {
			return Principal{}, false, err
		}
		renewed = true
	}
	return Principal{Username: s.username, Via: ViaCookie}, renewed, nil
}

// SessionCookie builds the persistent cookie for a raw session token.
func (s *Service) SessionCookie(raw string) *http.Cookie {
	return &http.Cookie{
		Name:     SessionCookieName,
		Value:    raw,
		Path:     "/",
		MaxAge:   int(s.ttl.Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode, // blocks cross-site posts, the service is same-origin
	}
}

// ClearSessionCookie expires the session cookie client-side.
func (s *Service) ClearSessionCookie() *http.Cookie {
	c := s.SessionCookie("")
	c.MaxAge = -1
	return c
}

// newSecret mints a random opaque token value.
func newSecret() (string, error) {
	b := make([]byte, secretLen)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("read crypto/rand: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// hashSecret reduces a raw secret to its stored form.
func hashSecret(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}
