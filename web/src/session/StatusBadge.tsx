import type { ReactElement } from 'react'

import type { SessionBadge } from '../workspace/attention'

// The copy and class per badge state. 'ended' widens the vocabulary for the
// switcher's exited tail, the headers stop at the live states.
const badgeClasses: Record<SessionBadge | 'ended', string> = {
  input: 'danger',
  running: 'accent',
  queued: 'warn',
  waiting: '',
  idle: '',
  ended: 'danger',
}

const badgeLabels: Record<SessionBadge | 'ended', string> = {
  input: 'needs input',
  running: 'running',
  queued: 'queued',
  waiting: 'waiting',
  idle: 'idle',
  ended: 'ended',
}

// StatusBadge renders one session's badge state with the copy and classes
// every surface shares: the desktop and mobile session headers and the
// switcher rows, so no surface drifts apart.
export function StatusBadge({ status }: { status: SessionBadge | 'ended' }): ReactElement {
  const extra = badgeClasses[status]
  return <span className={`badge${extra ? ` ${extra}` : ''}`}>{badgeLabels[status]}</span>
}
