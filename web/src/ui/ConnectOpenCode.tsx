import { useState } from 'react'
import { pairOffer } from '../opencode/pairings'
import { PairForm, PairOfferCard, ServerDot, useOpenCode } from './OpenCodeServers'
import { useValue } from './useValue'

/**
 * The canvas list's OpenCode panel. Not connected yet: the pairing offer the page was opened with
 * as the main call to action (or the manual steps without one). Connected: which OpenCode, and
 * how many sessions it has to bring onto canvases.
 */
export function ConnectOpenCode() {
	const { servers, sessions, errors } = useOpenCode()
	const offer = useValue(() => pairOffer.get())
	const [pairing, setPairing] = useState(false)

	if (!servers.length || pairing) {
		return (
			<section className="connect-panel">
				<PairForm large onPaired={() => setPairing(false)} onCancel={servers.length ? () => setPairing(false) : undefined} />
				{!offer && !servers.length && (
					<p className="connect-panel-why">Connecting lets canvases list your OpenCode sessions, seed themselves from their media and talk to them.</p>
				)}
			</section>
		)
	}

	const failing = servers.filter((s) => errors[s.key])
	return (
		<section className="connect-status">
			<div className="connect-status-row">
				<ServerDot health={failing.length ? { ok: false, error: errors[failing[0].key] } : sessions ? { ok: true } : undefined} />
				<span>
					Connected to OpenCode{' '}
					{servers.map((s, i) => (
						<span key={s.key}>
							{i > 0 && ', '}
							<strong>{s.name}</strong>
						</span>
					))}
					{sessions && !failing.length && (
						<span className="connect-status-meta">
							{' '}
							· {sessions.length} session{sessions.length === 1 ? '' : 's'}
						</span>
					)}
				</span>
				<button className="oc-link" onClick={() => setPairing(true)}>
					Pair another
				</button>
			</div>
			{failing.map((s) => (
				<span key={s.key} className="connect-status-error">
					{s.name}: {errors[s.key]}
				</span>
			))}
			{offer && <PairOfferCard inline />}
		</section>
	)
}
