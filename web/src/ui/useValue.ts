import { useMemo, useSyncExternalStore } from 'react'
import { computed, react } from '../state/signals'

/** Subscribe a React component to a derived signal value. Re-renders only when the value changes. */
export function useValue<T>(fn: () => T, deps: unknown[] = []): T {
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const signal = useMemo(() => computed('useValue', fn), deps)
	return useSyncExternalStore(
		(onChange) => {
			let first = true
			return react(() => {
				signal.get()
				if (first) first = false
				else onChange()
			})
		},
		() => signal.get(),
	)
}
