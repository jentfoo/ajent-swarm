import { useEffect, useState } from 'react'

// mobileLayout is where the phone-first chrome takes over. theme.css repeats
// this breakpoint in its @media rules; change both together, since CSS cannot
// read a TS constant.
export const mobileLayout = '(max-width: 48rem)'

// useMediaQuery mirrors a CSS media query into React, driving the chrome
// switch between desktop and mobile variants of the same route tree.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}
