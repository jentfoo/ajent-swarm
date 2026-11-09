import { useState } from 'react'
import type { FormEvent } from 'react'

import { describeError } from '../api/errors'
import { useAuth } from '../providers/auth'

// bcrypt's hard input limit; the server rejects anything past it. Measured in
// bytes, so multibyte characters count heavier than they look.
const maxPasswordBytes = 72

// BootstrapScreen sets the first password, shown only while the backend
// reports bootstrap-required. Loopback is enforced server-side.
export default function BootstrapScreen() {
  const { bootstrap } = useAuth()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    if (busy) return
    if (new TextEncoder().encode(password).length > maxPasswordBytes) {
      setError(`Password is too long. Use at most ${maxPasswordBytes} bytes.`)
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await bootstrap(password)
      // A successful save and another tab's 409 both drop the gate to login.
    } catch (err) {
      setBusy(false)
      setError(describeError(err, 'Bootstrap failed.'))
    }
  }

  return (
    <div className="auth-screen">
      <form className="card auth-card" onSubmit={submit}>
        <h1>ajent-swarm</h1>
        <p className="muted">Set the first password for your unix account.</p>
        <label>
          New password
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            autoFocus
            required
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
          />
        </label>
        <label>
          Confirm password
          <input
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(ev) => setConfirm(ev.target.value)}
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          Save password
        </button>
      </form>
    </div>
  )
}
