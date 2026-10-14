import { useEffect, useState } from 'react'

/** Phone-sized screens: the breakpoint the top bar and tool picker rearrange at (see styles.css). */
export const NARROW_QUERY = '(max-width: 640px)'

export function useMediaQuery(query: string) {
	const [matches, setMatches] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches)
	useEffect(() => {
		const list = matchMedia(query)
		const update = () => setMatches(list.matches)
		update()
		list.addEventListener('change', update)
		return () => list.removeEventListener('change', update)
	}, [query])
	return matches
}
