import { ApiError } from './client'

// describeError renders a caught error as user-facing copy: ApiError codes map
// through the table below, unknown codes keep the server's detail, anything
// else answers the fallback. Presentation only, branching stays on err.code.
export function describeError(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback
  const copy = errorCopy[err.code]
  if (copy === undefined) return err.detail !== '' ? err.detail : fallback
  return typeof copy === 'function' ? copy(err) : copy
}

type ErrorCopy = string | ((err: ApiError) => string)

// detailOr prefers the server's reason when the envelope carried one
const detailOr =
  (copy: string): ((err: ApiError) => string) =>
  (err) =>
    err.detail !== '' ? err.detail : copy

// rateLimitedCopy names when the login budget reopens, rounded up so the
// wait never reads shorter than it is. A missing Retry-After still reads
// sensibly.
function rateLimitedCopy(err: ApiError): string {
  const wait = err.retryAfter
  if (wait === undefined) return 'Too many attempts. Wait a moment and try again.'
  if (wait < 60) return `Too many attempts. Try again in ${wait} second${wait === 1 ? '' : 's'}.`
  const mins = Math.ceil(wait / 60)
  return `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`
}

// Copy per error code: swarm's snake_case beside the hyphenated wire codes
// ajent refusals keep. detailOr entries keep the server's reason so holder
// names and causes survive, codes absent here render their detail, which
// ajent always words for people.
const errorCopy: Record<string, ErrorCopy> = {
  invalid_credentials: 'Wrong username or password.',
  rate_limited: rateLimitedCopy,
  unauthorized: 'Your sign-in expired. Sign in again.',
  bootstrap_required: 'Sign-in is not set up yet. Reload to create the first password.',
  already_bootstrapped: 'A password is already set. Sign in with it.',
  remote_bootstrap_forbidden:
    'The first password can only be set from this machine. Pass --allow-remote-bootstrap to allow remote setup.',
  cross_site_blocked: 'The request was blocked as cross-site.',

  network_error: 'Cannot reach ajent-swarm. Check that the service is running.',
  bad_response: 'The service replied in an unreadable format.',
  unknown_error: 'The request failed without a reason.',

  invalid_request: detailOr('The request was not understood.'),
  body_too_large: 'The request is too large.',
  method_not_allowed: 'This action is not supported here.',

  internal_error: detailOr('The service hit an internal error.'),
  not_found: 'Not found.',
  'not-found': detailOr('Not found.'),
  session_not_found: 'This session is no longer running.',
  job_not_found: 'This job no longer exists.',
  conflict: detailOr('The change conflicts with what is saved. Reload and try again.'),
  name_taken: 'That name is already taken.',
  unavailable: detailOr('The session is not available right now.'),
  launch_failed: detailOr('Launching the session failed.'),
  stop_failed: detailOr('Stopping the session failed.'),
}
