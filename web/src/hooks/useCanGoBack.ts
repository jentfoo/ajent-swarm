import { useLocation, useNavigationType } from 'react-router'

// useCanGoBack reports whether an in-app entry sits behind the current
// location, so a back control can pop like the hardware gesture does. False
// on a cold deep link (react-router's 'default' key) and after a replace
// landing such as the login redirect, whose fresh key hides an empty stack.
export function useCanGoBack(): boolean {
  const location = useLocation()
  const navType = useNavigationType()
  return location.key !== 'default' && navType !== 'REPLACE'
}
