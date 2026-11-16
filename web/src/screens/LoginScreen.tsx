import { useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'

import { describeError } from '../api/errors'
import { useAuth } from '../providers/auth'

// LoginScreen signs in with the unix account. The location state carries
// where an expired session started (path plus query), so signing in returns
// there.
export default function LoginScreen() {
  const { login, status } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (status === 'authed') {
    // Already signed in (a parallel tab logged in, or back-navigation).
    return <Navigate to={fromLocation(location.state) || '/'} replace />
  }

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await login(username.trim(), password)
      navigate(fromLocation(location.state) || '/', { replace: true })
    } catch (err) {
      setBusy(false)
      setError(describeError(err, 'Login failed.'))
    }
  }

  return (
    <div className="auth-screen">
      <form className="card auth-card" onSubmit={submit}>
        <h1>ajent-swarm</h1>
        <p className="muted">Sign in with your unix account.</p>
        <label>
          Username
          <input
            name="username"
            autoComplete="username"
            autoFocus
            required
            value={username}
            onChange={(ev) => setUsername(ev.target.value)}
          />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          Sign in
        </button>
      </form>
    </div>
  )
}

// fromLocation reads the redirect target AuthGate stored on its way to
// /login. History state is client-writable, so only same-origin absolute
// paths are honored and anything else falls back home.
function fromLocation(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from
  if (typeof from !== 'string') return ''
  // "//" is a protocol-relative URL and "\\" parses like one, both off-site
  if (!from.startsWith('/') || from.startsWith('//') || from.includes('\\')) return ''
  return from
}
