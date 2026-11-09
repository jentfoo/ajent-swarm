// Typed fetch wrapper over the REST surface. Cookie auth rides
// automatically on same-origin calls; every failure surfaces as an ApiError
// carrying the backend's structured body, never a flattened string.

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly detail: string // the backend's own message, if any
  readonly retryAfter?: number // seconds until a retry may pass, from Retry-After

  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message === '' ? code : `${code}: ${message}`)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.detail = message
    this.retryAfter = retryAfter
  }
}

type UnauthorizedListener = (err: ApiError) => void

const unauthorizedListeners = new Set<UnauthorizedListener>()

// onUnauthorized registers a listener fired once per 401 response, so the auth
// layer can drop to the login screen wherever an expired session surfaces.
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener)
  return () => unauthorizedListeners.delete(listener)
}

function notifyUnauthorized(err: ApiError) {
  for (const listener of unauthorizedListeners) {
    listener(err)
  }
}

export interface RequestOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined
  const text = await res.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError(res.status, 'bad_response', 'response was not valid JSON')
  }
}

// errorBody reads the standard envelope off a failed response; any other body
// shape still surfaces with its status and a generic code.
async function errorBody(res: Response): Promise<ApiError> {
  const retryAfter = retryAfterOf(res)
  const text = await res.text()
  if (text !== '') {
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string }
      if (typeof parsed.error === 'string') {
        return new ApiError(res.status, parsed.error, parsed.message ?? '', retryAfter)
      }
    } catch {
      // fall through to the generic code
    }
  }
  return new ApiError(res.status, 'unknown_error', '', retryAfter)
}

// retryAfterOf reads the Retry-After delta-seconds form, the only one swarm
// sends; absent or unusable answers undefined
function retryAfterOf(res: Response): number | undefined {
  const secs = Number(res.headers.get('retry-after'))
  if (!Number.isFinite(secs) || secs <= 0) return undefined
  return Math.ceil(secs)
}

// request performs one API call and unwraps the standard error envelope.
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      signal: opts.signal,
    })
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') throw cause
    throw new ApiError(0, 'network_error', `request to ${path} failed`)
  }
  return unwrap<T>(res)
}

// postForm uploads one multipart body; the browser supplies the boundary.
export async function postForm<T>(path: string, form: FormData): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { method: 'POST', body: form, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'network_error', `request to ${path} failed`)
  }
  return unwrap<T>(res)
}

// unwrap turns every failure into an ApiError carrying the structured body.
async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err = await errorBody(res)
    if (res.status === 401) notifyUnauthorized(err)
    throw err
  }
  return (await parseBody(res)) as T
}

export async function get<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return request<T>(path, { ...opts, method: 'GET' })
}

export async function post<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  return request<T>(path, { ...opts, method: 'POST', body })
}

export async function put<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  return request<T>(path, { ...opts, method: 'PUT', body })
}

export async function del<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return request<T>(path, { ...opts, method: 'DELETE' })
}
