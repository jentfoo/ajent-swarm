import { describe, expect, it } from 'vitest'

import { ApiError } from './client'
import { describeError } from './errors'

describe('describeError', () => {
  it('answers the fallback for non-API errors', () => {
    expect(describeError(new Error('boom'), 'Loading failed.')).toBe('Loading failed.')
    expect(describeError('nope', 'Loading failed.')).toBe('Loading failed.')
    expect(describeError(undefined, 'Loading failed.')).toBe('Loading failed.')
  })

  it.each([
    ['invalid_credentials', '', 'Wrong username or password.'],
    ['unauthorized', '', 'Your sign-in expired. Sign in again.'],
    ['already_bootstrapped', '', 'A password is already set. Sign in with it.'],
    [
      'network_error',
      'request to /api/x failed',
      'Cannot reach ajent-swarm. Check that the service is running.',
    ],
    ['session_not_found', '', 'This session is no longer running.'],
    ['job_not_found', '', 'This job no longer exists.'],
    ['body_too_large', 'http: request body too large', 'The request is too large.'],
  ])('humanizes %s without its detail', (code, detail, want) => {
    expect(describeError(new ApiError(400, code, detail), 'Fallback.')).toBe(want)
  })

  it.each([
    ['invalid_request', 'limit must be a positive integer', 'limit must be a positive integer'],
    ['internal_error', 'writing the setting failed', 'writing the setting failed'],
    ['unavailable', 'session is shutting down', 'session is shutting down'],
    ['not-found', 'no such interaction 3', 'no such interaction 3'],
  ])('keeps the server detail for %s', (code, detail, want) => {
    expect(describeError(new ApiError(409, code, detail), 'Fallback.')).toBe(want)
  })

  it.each([
    ['invalid_request', 'The request was not understood.'],
    ['internal_error', 'The service hit an internal error.'],
    ['unavailable', 'The session is not available right now.'],
  ])('uses the fixed copy for a detail-less %s', (code, want) => {
    expect(describeError(new ApiError(500, code, ''), 'Fallback.')).toBe(want)
  })

  it('renders unknown codes through their detail', () => {
    const err = new ApiError(409, 'seat-held', 'control seat held by human-2')
    expect(describeError(err, 'Take control refused.')).toBe('control seat held by human-2')
  })

  it('falls back for an unknown code without detail', () => {
    expect(describeError(new ApiError(409, 'session_busy', ''), 'Rename failed.')).toBe(
      'Rename failed.',
    )
  })

  it.each([
    [1, 'Too many attempts. Try again in 1 second.'],
    [45, 'Too many attempts. Try again in 45 seconds.'],
    [60, 'Too many attempts. Try again in 1 minute.'],
    [125, 'Too many attempts. Try again in 3 minutes.'],
  ])('names the wait from Retry-After (%s seconds)', (retryAfter, want) => {
    const err = new ApiError(
      429,
      'rate_limited',
      'too many failed attempts; retry later',
      retryAfter,
    )
    expect(describeError(err, 'Login failed.')).toBe(want)
  })

  it('stays sensible without a Retry-After value', () => {
    expect(describeError(new ApiError(429, 'rate_limited', ''), 'Login failed.')).toBe(
      'Too many attempts. Wait a moment and try again.',
    )
  })
})
