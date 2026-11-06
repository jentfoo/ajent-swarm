import { useMemo } from 'react'

import { useAuth } from '../providers/auth'
import { useSwarm } from '../providers/swarm'
import { useWorkspace } from '../providers/workspace'
import { displayName } from '../session/names'
import { buildSwitcherRows } from './switcher'

// useSwitcherRows folds discovery plus the attention digest into the sheet's
// rows through one shared model, so the home launcher and the in-session
// switcher can never disagree about order, badges or labels.
export function useSwitcherRows() {
  const { sessions } = useSwarm()
  const { home } = useAuth()
  const { needs, waiting, working } = useWorkspace()

  return useMemo(
    () =>
      buildSwitcherRows(sessions, (s) => displayName(s, home), [...needs, ...waiting, ...working]),
    [sessions, home, needs, waiting, working],
  )
}
