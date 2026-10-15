import { useEffect, useState, type ReactNode } from 'react'
import type { OpenCodeSessionSummary } from '../../../shared/types'
import { OPENCODE_ALLOWED, OPENCODE_HINT } from '../base'
import { health, pairFromLink, pairings, renamePairing, unpair, type Pairing, type PairingHealth } from '../opencode/pairings'
import { listSessions } from '../opencode/sessions'
import { useValue } from './useValue'

export interface OpenCodeState {
	/** the OpenCode servers paired in this browser */
	servers: Pairing[]
	/** null while loading */
	sessions: OpenCodeSessionSummary[] | null
	/** servers whose sessions couldn't be listed, by key */
	errors: Record<string, string>
	reload: () => Promise<void>
}

/** The OpenCode servers paired in this browser and their sessions (talked to directly, from here). */
export function useOpenCode(): OpenCodeState {
	const servers = useValue(() => pairings.get())
	const [sessions, setSessions] = useState<OpenCodeSessionSummary[] | null>(null)
	const [errors, setErrors] = useState<Record<string, string>>({})
	const serverKeys = servers.map((s) => `${s.key}:${s.token.length}:${s.name}`).join(' ')

	const reload = async () => {
		if (!OPENCODE_ALLOWED || !pairings.peek().length) {
			setSessions([])
			setErrors({})
			return
		}
		const listing = await listSessions()
		setSessions(listing.sessions)
		setErrors(listing.errors)
	}
	useEffect(() => {
		setSessions(null)
		reload()
	}, [serverKeys])
	return { servers, sessions, errors, reload }
}

/** Instead of OpenCode features, on pages OpenCode doesn't allow (anything but localhost). */
export function OpenCodeHint() {
	const [before, after] = OPENCODE_HINT.split('`bunx opencode-canvas`')
	return (
		<p className="oc-hint">
			{before}
			<code>bunx opencode-canvas</code>
			{after}.
		</p>
	)
}

/** "Connect your OpenCode": paste the link `opencode pair` prints. */
export function PairForm({ onPaired, onCancel, autoFocus }: { onPaired: (server: Pairing) => void; onCancel?: () => void; autoFocus?: boolean }) {
	const [link, setLink] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	if (!OPENCODE_ALLOWED) return <OpenCodeHint />

	const connect = async () => {
		if (!link.trim() || busy) return
		setBusy(true)
		setError(null)
		try {
			const server = await pairFromLink(link.trim())
			setLink('')
			onPaired(server)
		} catch (e) {
			setError((e as Error).message)
		} finally {
			setBusy(false)
		}
	}

	return (
		<form
			className="oc-pair"
			onSubmit={(e) => {
				e.preventDefault()
				connect()
			}}
		>
			<strong className="oc-pair-title">Connect your OpenCode</strong>
			<p className="oc-pair-hint">
				Run <code>bunx opencode-canvas</code> to open this canvas already connected, or run <code>opencode pair</code> and paste the link here. This
				browser talks to OpenCode directly; the canvas server never sees it.
			</p>
			<div className="oc-pair-row">
				<input
					autoFocus={autoFocus}
					placeholder="http://…/auth/connect/…"
					value={link}
					spellCheck={false}
					autoComplete="off"
					onChange={(e) => setLink(e.target.value)}
					onKeyDown={(e) => {
						e.stopPropagation()
						if (e.key === 'Escape' && onCancel) onCancel()
					}}
				/>
				<button type="submit" className="oc-primary" disabled={busy || !link.trim()}>
					{busy ? 'Connecting…' : 'Connect'}
				</button>
			</div>
			{error && <div className="oc-error">{error}</div>}
			{onCancel && (
				<button type="button" className="oc-link" onClick={onCancel}>
					Cancel
				</button>
			)}
		</form>
	)
}

/** The servers paired in this browser: rename inline, unpair (click twice), pair another. */
export function ServerList({ servers, errors }: { servers: Pairing[]; errors: Record<string, string> }) {
	const [pairing, setPairing] = useState(false)
	const [editing, setEditing] = useState<string | null>(null)
	const [name, setName] = useState('')
	const [confirming, setConfirming] = useState<string | null>(null)
	const healthy = useValue(() => health.get())

	const rename = (s: Pairing) => {
		setEditing(null)
		const next = name.trim()
		if (next && next !== s.name) renamePairing(s.key, next)
	}

	const remove = (s: Pairing) => {
		if (confirming !== s.key) return setConfirming(s.key)
		setConfirming(null)
		unpair(s.key)
	}

	return (
		<div className="oc-servers">
			{servers.map((s) => {
				const error = errors[s.key] ?? healthy[s.key]?.error
				return (
					<div key={s.key} className="oc-server">
						<ServerDot health={error ? { ok: false, error } : healthy[s.key]} />
						<span className="oc-server-main">
							{editing === s.key ? (
								<input
									className="oc-server-name-input"
									autoFocus
									value={name}
									maxLength={60}
									onChange={(e) => setName(e.target.value)}
									onBlur={() => rename(s)}
									onKeyDown={(e) => {
										e.stopPropagation()
										if (e.key === 'Enter') rename(s)
										if (e.key === 'Escape') setEditing(null)
									}}
								/>
							) : (
								<button
									className="oc-server-name"
									title="Rename"
									onClick={() => {
										setName(s.name)
										setEditing(s.key)
									}}
								>
									{s.name}
								</button>
							)}
							<span className="oc-server-meta">{hostOf(s.url)}</span>
							{error && <span className="oc-server-error">{error}</span>}
						</span>
						<button
							className={`oc-unpair${confirming === s.key ? ' confirming' : ''}`}
							title={confirming === s.key ? 'Click again to unpair: your worms from it fall asleep' : 'Unpair this server (forget it in this browser)'}
							onClick={() => remove(s)}
							onBlur={() => confirming === s.key && setConfirming(null)}
						>
							{confirming === s.key ? 'Unpair?' : 'Unpair'}
						</button>
					</div>
				)
			})}
			{pairing ? (
				<PairForm autoFocus onPaired={() => setPairing(false)} onCancel={() => setPairing(false)} />
			) : (
				<button className="oc-link" onClick={() => setPairing(true)}>
					+ Pair another
				</button>
			)}
		</div>
	)
}

export function ServerDot({ health }: { health: PairingHealth | undefined }) {
	const state = health?.ok ? 'is-ok' : health?.error ? 'is-failing' : ''
	return <span className={`oc-server-dot ${state}`} title={health?.ok ? 'Connected' : health?.error ? `Not reachable: ${health.error}` : 'Not connected yet'} />
}

/**
 * Renders sessions, grouped under a heading per server when more than one is paired (servers
 * whose sessions couldn't be listed show their error instead).
 */
export function SessionGroups({
	servers,
	sessions,
	errors,
	render,
}: {
	servers: Pairing[]
	sessions: OpenCodeSessionSummary[]
	errors: Record<string, string>
	render: (s: OpenCodeSessionSummary) => ReactNode
}) {
	if (servers.length <= 1) {
		const error = servers[0] && errors[servers[0].key]
		return error ? <div className="oc-group-error">{error}</div> : <>{sessions.map(render)}</>
	}
	return (
		<>
			{servers.map((server) => {
				const mine = sessions.filter((s) => s.serverKey === server.key)
				const error = errors[server.key]
				return (
					<div key={server.key} className="oc-group">
						<div className="oc-group-head">
							<ServerDot health={error ? { ok: false, error } : { ok: true }} />
							<span>{server.name}</span>
							{!error && <span className="oc-group-count">{mine.length}</span>}
						</div>
						{error ? <div className="oc-group-error">{error}</div> : mine.length ? mine.map(render) : <div className="oc-group-empty">No sessions</div>}
					</div>
				)
			})}
		</>
	)
}

export const sessionKey = (s: { serverKey: string; id: string }) => `${s.serverKey}/${s.id}`

function hostOf(url: string) {
	try {
		return new URL(url).host
	} catch {
		return url
	}
}
