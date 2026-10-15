import { useEffect, useState, type ReactNode } from 'react'
import type { OpenCodeSessionSummary } from '../../../shared/types'
import { CORS_COMMAND, OPENCODE_ALLOWS_PAGE } from '../base'
import { health, pairFromLink, PairingError, pairOffer, pairings, redeem, renamePairing, unpair, type Pairing, type PairingHealth } from '../opencode/pairings'
import { listSessions } from '../opencode/sessions'
import { atom } from '../state/signals'
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
		if (!pairings.peek().length) {
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

/** A shell command to run, with a button that copies it. */
export function CopyCommand({ command, title }: { command: string; title?: string }) {
	const [copied, setCopied] = useState(false)
	const copy = () =>
		navigator.clipboard.writeText(command).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		})
	return (
		<span className="oc-cmd" title={title}>
			<code>{command}</code>
			<button type="button" className="oc-copy" onClick={copy}>
				{copied ? 'Copied' : 'Copy'}
			</button>
		</span>
	)
}

/** Text with its `backticked` parts as code. */
export function CodeText({ text }: { text: string }) {
	return <>{text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</>
}

/** Why pairing failed, with the command that fixes it (if there is one). */
export function PairErrorView({ error }: { error: Error }) {
	return (
		<div className="oc-error">
			<p className="oc-error-text">
				<CodeText text={error.message} />
			</p>
			{error instanceof PairingError && error.command && <CopyCommand command={error.command} title={CORS_TITLE} />}
		</div>
	)
}

/** How many pairing forms show the offer inline (PairNotice shows it as a toast when none do). */
export const offersShownInline = atom('offersShownInline', 0)

/** What to run for a new pairing code from the command that opened this page. */
export const CLI_COMMAND = 'bunx github:jlongster/opencode-canvas'

/**
 * The pairing code the page was opened with: who it would connect, and a Connect button (it never
 * connects by itself). × forgets it. `large`: the first thing on a page (empty canvas, canvas list).
 */
export function PairOfferCard({ inline, large, onPaired }: { inline?: boolean; large?: boolean; onPaired?: (server: Pairing) => void }) {
	const offer = useValue(() => pairOffer.get())
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<Error | null>(null)
	useEffect(() => {
		if (!inline) return
		offersShownInline.set(offersShownInline.peek() + 1)
		return () => offersShownInline.set(offersShownInline.peek() - 1)
	}, [inline])
	useEffect(() => setError(null), [offer])
	if (!offer) return null
	const host = hostOf(offer.url)
	const used = error instanceof PairingError && error.used

	const connect = async () => {
		setBusy(true)
		setError(null)
		try {
			const server = await redeem(offer)
			pairOffer.set(null)
			onPaired?.(server)
		} catch (e) {
			setError(e as Error)
		} finally {
			setBusy(false)
		}
	}

	const manually = inline ? 'pair manually instead' : 'pair manually (Conjure)'
	return (
		<div className={`oc-offer${large ? ' oc-offer-large' : ''}`}>
			<div className="oc-offer-row">
				{large ? (
					<span className="oc-offer-text">
						<strong>{offer.from === 'cli' ? 'Found OpenCode on this machine' : 'This link wants to connect OpenCode'}</strong>
						<span>
							at <code>{host}</code>
						</span>
					</span>
				) : (
					<span className="oc-offer-text">
						{offer.from === 'cli' ? 'Found OpenCode on this machine' : 'This link wants to connect OpenCode at'} <code>{host}</code>
					</span>
				)}
				{!used && (
					<button type="button" className="oc-primary" disabled={busy} onClick={connect}>
						{busy ? 'Connecting…' : 'Connect'}
					</button>
				)}
				<button type="button" className="oc-offer-dismiss" title="Forget this pairing code" onClick={() => pairOffer.set(null)}>
					×
				</button>
			</div>
			{large && !used && !error && <span className="oc-offer-note">Connect lets this page list your sessions and talk to them. The token stays in this browser.</span>}
			{used ? (
				<div className="oc-error">
					<p className="oc-error-text">
						<CodeText
							text={
								offer.from === 'cli'
									? `That pairing code expired or was already used. Run \`${CLI_COMMAND}\` again, or ${manually}.`
									: `That pairing link expired or was already used. Ask for a new one, or ${manually}.`
							}
						/>
					</p>
				</div>
			) : (
				error && <PairErrorView error={error} />
			)}
		</div>
	)
}

const CORS_TITLE = "Replaces OpenCode's list of extra allowed sites (separate several with commas) and restarts its background server"

/**
 * "Connect your OpenCode": run `opencode pair` where OpenCode runs and paste the link it prints
 * (or open this page with #pair=<link>). Sites other than localhost must be allowed in OpenCode
 * first, which the form says how to do.
 */
export function PairForm({
	onPaired,
	onCancel,
	autoFocus,
	large,
	title = 'Connect your OpenCode',
}: {
	onPaired: (server: Pairing) => void
	onCancel?: () => void
	autoFocus?: boolean
	/** the offer as the page's main call to action, with the manual steps folded away */
	large?: boolean
	title?: string
}) {
	const [link, setLink] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<Error | null>(null)
	const [manual, setManual] = useState(false)
	const offer = useValue(() => pairOffer.get())
	const folded = large && !!offer && !manual

	const connect = async () => {
		if (!link.trim() || busy) return
		setBusy(true)
		setError(null)
		try {
			const server = await pairFromLink(link)
			setLink('')
			onPaired(server)
		} catch (e) {
			setError(e as Error)
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
			{!(large && offer) && <strong className="oc-pair-title">{title}</strong>}
			<PairOfferCard inline large={large} onPaired={onPaired} />
			{folded ? (
				<button type="button" className="oc-link oc-manual-toggle" onClick={() => setManual(true)}>
					Pair manually instead
				</button>
			) : (
				<>
					{offer && <span className="oc-or">Or pair manually:</span>}
					{!OPENCODE_ALLOWS_PAGE && (
						<div className="oc-setup">
							<span>First time on this site? Run</span>
							<CopyCommand command={CORS_COMMAND} title={CORS_TITLE} />
						</div>
					)}
					<ol className="oc-steps">
						<li>
							<span className="oc-step-num">1</span>
							<div className="oc-step-body">
								<span>On the machine running OpenCode, run</span>
								<CopyCommand command="opencode pair" />
							</div>
						</li>
						<li>
							<span className="oc-step-num">2</span>
							<div className="oc-step-body">
								<span>Paste the link it prints</span>
								<div className="oc-pair-row">
									<input
										autoFocus={autoFocus}
										placeholder="http://…/auth/connect/…"
										aria-label="Pairing link"
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
								<span className="oc-pair-note">The code works once. The token it gives stays in this browser only.</span>
							</div>
						</li>
					</ol>
					{error && <PairErrorView error={error} />}
				</>
			)}
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
