import { useEffect } from 'react'
import { OPENCODE_ALLOWED, OPENCODE_HINT } from '../base'
import { parsePairFragment, redeem, stripPairFragment } from '../opencode/pairings'
import { atom } from '../state/signals'
import { useValue } from './useValue'

type Notice = { state: 'pairing'; host: string } | { state: 'paired'; name: string } | { state: 'error'; message: string }

const notice = atom<Notice | null>('pairNotice', null)
const SHOW_PAIRED_MS = 4000

/**
 * Redeems a `#pair=<…>` fragment (from `bunx opencode-canvas`), removing it from the URL first so a
 * reload or a shared link never carries the code. Call once, before anything reads the hash.
 */
export function redeemPairFragment() {
	if (!/(?:^#|&)pair=/.test(location.hash)) return
	const target = parsePairFragment(location.hash)
	history.replaceState(history.state, '', `${location.pathname}${location.search}${stripPairFragment(location.hash)}`)
	if (!target) return notice.set({ state: 'error', message: 'That pairing link is malformed. Run `bunx opencode-canvas` again for a new one.' })
	if (!OPENCODE_ALLOWED) return notice.set({ state: 'error', message: `This page can't reach OpenCode. ${OPENCODE_HINT}.` })
	notice.set({ state: 'pairing', host: new URL(target.url).host })
	redeem(target)
		.then((p) => notice.set({ state: 'paired', name: p.name }))
		.catch((e: Error) => notice.set({ state: 'error', message: `Couldn't connect to OpenCode: ${e.message}` }))
}

/** A small toast for the pairing from the URL fragment: connecting, connected, or why it failed. */
export function PairNotice() {
	const n = useValue(() => notice.get())
	useEffect(() => {
		if (n?.state !== 'paired') return
		const t = setTimeout(() => notice.set(null), SHOW_PAIRED_MS)
		return () => clearTimeout(t)
	}, [n])
	if (!n) return null
	return (
		<div className={`pair-notice ${n.state}`} role="status">
			<span>
				{n.state === 'pairing' ? `Connecting to OpenCode at ${n.host}…` : n.state === 'paired' ? `Connected to OpenCode (${n.name})` : n.message}
			</span>
			{n.state !== 'pairing' && (
				<button title="Dismiss" onClick={() => notice.set(null)}>
					×
				</button>
			)}
		</div>
	)
}
