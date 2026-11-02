import { useEffect, useState } from 'react'

// useMediaQuery mirrors a CSS media query into React, driving the chrome
// switch between desktop and mobile variants of the same route tree.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => evaluate(query))

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}

function evaluate(query: string): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia(query).matches
}
