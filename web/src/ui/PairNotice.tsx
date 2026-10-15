import { useEffect, useState } from 'react'
import { pairOffer, takePairFragment } from '../opencode/pairings'
import { atom } from '../state/signals'
import { CodeText, offersShownInline, PairOfferCard } from './OpenCodeServers'
import { useValue } from './useValue'

type Notice = { state: 'paired'; name: string } | { state: 'error'; message: string }

const notice = atom<Notice | null>('pairNotice', null)
const SHOW_PAIRED_MS = 4000
/** Lets a pairing form that's about to show (the empty canvas) take the offer before the toast does. */
const OFFER_TOAST_DELAY_MS = 800

/**
 * Takes a `#pair=<…>` fragment (from `bunx opencode-canvas`, or a pairing link someone appended to
 * a canvas link) out of the URL and offers it: nothing is redeemed until the user clicks Connect.
 * Call once, before anything reads the hash; it also takes ones added later (a link pasted into
 * the address bar of this page only changes the hash).
 */
export function readPairFragment() {
	const take = () => {
		if (!takePairFragment()) notice.set({ state: 'error', message: 'That pairing link is malformed. Run `opencode pair` again for a new one.' })
	}
	take()
	window.addEventListener('hashchange', take)
}

/**
 * A small toast with the pairing offer, where no pairing form shows it (something is paired
 * already, or there's no form on screen); then whether it connected.
 */
export function PairNotice({ offers = true }: { offers?: boolean }) {
	const n = useValue(() => notice.get())
	const offered = useValue(() => offers && !!pairOffer.get() && offersShownInline.get() === 0)
	const [showOffer, setShowOffer] = useState(false)
	useEffect(() => {
		if (!offered) return setShowOffer(false)
		const t = setTimeout(() => setShowOffer(true), OFFER_TOAST_DELAY_MS)
		return () => clearTimeout(t)
	}, [offered])
	useEffect(() => {
		if (n?.state !== 'paired') return
		const t = setTimeout(() => notice.set(null), SHOW_PAIRED_MS)
		return () => clearTimeout(t)
	}, [n])

	if (showOffer && offered) {
		return (
			<div className="pair-notice pair-offer" role="status">
				<PairOfferCard onPaired={(p) => notice.set({ state: 'paired', name: p.name })} />
			</div>
		)
	}
	if (!n) return null
	return (
		<div className={`pair-notice pair-${n.state}`} role="status">
			<span>{n.state === 'paired' ? `Connected to OpenCode (${n.name})` : <CodeText text={n.message} />}</span>
			<button title="Dismiss" onClick={() => notice.set(null)}>
				×
			</button>
		</div>
	)
}
