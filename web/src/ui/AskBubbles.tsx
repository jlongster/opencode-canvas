import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AskingInfo } from '../multiplayer/Presence'
import type { SessionControl } from '../multiplayer/SessionControl'
import { isAskEvent, type Ask, type AskField, type AskValue, type PermissionAsk, type QuestionAsk } from '../opencode/asks'
import { onOpenCodeEvents } from '../opencode/events'
import { markdownToHtml } from './markdown'
import { useValue } from './useValue'

/** ask events come in bursts (a reply, then the next ask): the asks are read again once they settle */
const ASKS_REFETCH_MS = 120

/** One field's answer as it's being picked: the options chosen, and the typed answer (on when chosen). */
interface Draft {
	picked: string[]
	custom: boolean
	text: string
}

const EMPTY: Draft = { picked: [], custom: false, text: '' }

export interface AskActions {
	answer(ask: QuestionAsk, answer: Record<string, AskValue>): Promise<void>
	dismiss(ask: QuestionAsk): Promise<void>
	permit(ask: PermissionAsk, decision: 'once' | 'always' | 'reject'): Promise<void>
}

/** What a linked session is waiting on its owner to answer, from its live state (shared by its owner's tab). */
export function useAsking(sessions: SessionControl, sessionId: string): AskingInfo | null {
	const key = useValue(() => {
		const asking = sessions.live.get().get(sessionId)?.asking
		return asking?.count ? JSON.stringify(asking) : ''
	}, [sessions, sessionId])
	return useMemo(() => (key ? (JSON.parse(key) as AskingInfo) : null), [key])
}

/**
 * The questions and permission requests our own session waits on, read from its OpenCode when
 * shown, whenever what it's asking changes, and on its OpenCode's ask events; with the actions
 * that answer them (an answered one goes straight away). Nothing for sessions that aren't ours.
 */
export function useSessionAsks(sessions: SessionControl, sessionId: string, owner: boolean, asking: AskingInfo | null) {
	const [asks, setAsks] = useState<Ask[] | null>(null)
	const [loading, setLoading] = useState(false)
	const seq = useRef(0)
	const timer = useRef<number>(undefined)

	const load = useCallback(async () => {
		if (!sessions.ours(sessionId)) return
		const n = ++seq.current
		setLoading(true)
		const list = await sessions.asks(sessionId).catch(() => null)
		if (n !== seq.current) return
		setLoading(false)
		if (list) setAsks(list)
	}, [sessions, sessionId])

	const askingKey = asking ? JSON.stringify(asking) : ''
	useEffect(() => {
		if (owner) void load()
	}, [owner, askingKey, load])

	useEffect(() => {
		const r = sessions.record(sessionId)
		if (!owner || !r) return
		const off = onOpenCodeEvents(r.serverKey, {
			onEvent: (ev) => {
				if (!isAskEvent(ev.type)) return
				window.clearTimeout(timer.current)
				timer.current = window.setTimeout(() => void load(), ASKS_REFETCH_MS)
			},
		})
		return () => {
			off()
			window.clearTimeout(timer.current)
		}
	}, [owner, sessions, sessionId, load])

	const actions = useMemo<AskActions>(() => {
		const answered = (id: string) => {
			setAsks((list) => list?.filter((a) => a.id !== id) ?? null)
			void load()
		}
		return {
			answer: async (ask, answer) => {
				await sessions.answer(sessionId, ask, answer)
				answered(ask.id)
			},
			dismiss: async (ask) => {
				await sessions.dismiss(sessionId, ask)
				answered(ask.id)
			},
			permit: async (ask, decision) => {
				await sessions.permit(sessionId, ask, decision)
				answered(ask.id)
			},
		}
	}, [sessions, sessionId, load])

	return { asks: owner ? asks : null, loading, actions }
}

/**
 * While a session waits on its owner (in its prompt, or the card at its frame; see FrameAsks):
 * the oldest question (one bubble per field, in the session's colour: its options as rows, single
 * or multiple choice, and "Type your own answer" when allowed) or permission request (what the tool
 * wants to do), then one bubble with Submit / Dismiss, or Allow once / Always allow / Reject.
 */
export function AskBubbles({ asks, actions, more }: { asks: Ask[]; actions: AskActions; more: number }) {
	const ask = asks[0]
	return ask.kind === 'question' ? (
		<QuestionBubbles key={ask.id} ask={ask} actions={actions} more={more} />
	) : (
		<PermissionBubbles key={ask.id} ask={ask} actions={actions} more={more} />
	)
}

function QuestionBubbles({ ask, actions, more }: { ask: QuestionAsk; actions: AskActions; more: number }) {
	const fields = ask.fields.filter((f) => f.type !== 'external')
	const [drafts, setDrafts] = useState<Record<string, Draft>>({})
	const [busy, setBusy] = useState<null | 'submit' | 'dismiss'>(null)
	const [error, setError] = useState<string | null>(null)
	const firstRef = useRef<HTMLDivElement>(null)
	const draft = (f: AskField) => drafts[f.key] ?? EMPTY
	const set = (f: AskField, next: Partial<Draft>) => setDrafts((d) => ({ ...d, [f.key]: { ...(d[f.key] ?? EMPTY), ...next } }))

	useEffect(() => {
		firstRef.current?.focus({ preventScroll: true })
	}, [])

	const values = useMemo(() => {
		const out: Record<string, AskValue> = {}
		let missing = 0
		for (const f of fields) {
			const v = valueOf(f, drafts[f.key] ?? EMPTY)
			if (v === undefined) missing++
			else out[f.key] = v
		}
		return { out, missing }
	}, [drafts, ask])

	const submit = async () => {
		if (busy || values.missing) return
		setBusy('submit')
		setError(null)
		try {
			await actions.answer(ask, values.out)
		} catch (e) {
			setError((e as Error).message)
			setBusy(null)
		}
	}

	const dismiss = async () => {
		if (busy) return
		setBusy('dismiss')
		setError(null)
		try {
			await actions.dismiss(ask)
		} catch (e) {
			setError((e as Error).message)
			setBusy(null)
		}
	}

	const pick = (f: AskField, value: string) => {
		const d = draft(f)
		if (f.type === 'multi') set(f, { picked: d.picked.includes(value) ? d.picked.filter((v) => v !== value) : [...d.picked, value] })
		else set(f, { picked: [value], custom: false })
	}

	return (
		<div
			className="pt-asks"
			onKeyDown={(e) => {
				// Enter submits from anywhere but a button (which Enter presses)
				if (e.key === 'Enter' && !e.shiftKey && !(e.target as HTMLElement).closest('button')) {
					e.preventDefault()
					void submit()
				}
			}}
		>
			{fields.map((f, i) => {
				const d = draft(f)
				const textual = f.type === 'text' || f.type === 'number' || f.type === 'integer'
				return (
					<div key={f.key} ref={i === 0 ? firstRef : undefined} tabIndex={-1} className="pt-b pt-q" role="group" aria-label={f.title || f.text}>
						<div className="pt-q-head">
							<QuestionIcon />
							<span className="pt-q-title">{f.title || 'Question'}</span>
							{fields.length > 1 && (
								<span className="pt-q-n">
									{i + 1}/{fields.length}
								</span>
							)}
						</div>
						{f.text && <div className="pt-q-text pt-md" dangerouslySetInnerHTML={{ __html: markdownToHtml(f.text) }} />}
						{f.type === 'boolean' ? (
							<div className="pt-q-opts">
								{['Yes', 'No'].map((label) => (
									<Option key={label} label={label} multi={false} on={d.picked[0] === label} disabled={!!busy} onClick={() => set(f, { picked: [label] })} />
								))}
							</div>
						) : (
							!textual && (
								<div className="pt-q-opts" role={f.type === 'multi' ? 'group' : 'radiogroup'}>
									{f.options.map((o) => (
										<Option
											key={o.value}
											label={o.label}
											description={o.description}
											multi={f.type === 'multi'}
											on={d.picked.includes(o.value)}
											disabled={!!busy}
											onClick={() => pick(f, o.value)}
										/>
									))}
									{f.custom && (
										<Option
											label="Type your own answer"
											multi={f.type === 'multi'}
											on={d.custom}
											disabled={!!busy}
											onClick={() => set(f, f.type === 'multi' ? { custom: !d.custom } : { custom: true, picked: [] })}
										/>
									)}
								</div>
							)
						)}
						{(textual || d.custom) && (
							<input
								className="pt-q-input"
								autoFocus={!textual}
								value={d.text}
								disabled={!!busy}
								inputMode={f.type === 'number' || f.type === 'integer' ? 'decimal' : undefined}
								placeholder={f.placeholder ?? (textual ? 'Your answer' : 'Type your answer…')}
								onChange={(e) => set(f, { text: e.target.value })}
							/>
						)}
					</div>
				)
			})}
			<div className="pt-b pt-act">
				{error ? (
					<span className="pt-act-h pt-fail" title={error}>
						{error}
					</span>
				) : (
					<span className="pt-act-h">
						{values.missing ? `${values.missing} to answer` : 'Enter to submit'}
						{more > 0 && ` · ${more} more after this`}
					</span>
				)}
				<span className="pt-sp" />
				<button className="pt-btn ghost" title="Dismiss: answer nothing (stops its turn)" disabled={!!busy} onClick={dismiss}>
					{busy === 'dismiss' ? <span className="pt-spin pt-spin-xs" /> : 'Dismiss'}
				</button>
				<button className={`pt-btn pri${values.missing ? ' off' : ''}`} disabled={!!busy || values.missing > 0} onClick={submit}>
					{busy === 'submit' ? <span className="pt-spin pt-spin-xs dark" /> : 'Submit'}
				</button>
			</div>
		</div>
	)
}

function PermissionBubbles({ ask, actions, more }: { ask: PermissionAsk; actions: AskActions; more: number }) {
	const [busy, setBusy] = useState<null | 'once' | 'always' | 'reject'>(null)
	const [error, setError] = useState<string | null>(null)
	const onceRef = useRef<HTMLButtonElement>(null)
	useEffect(() => {
		onceRef.current?.focus({ preventScroll: true })
	}, [])
	const reply = async (decision: 'once' | 'always' | 'reject') => {
		if (busy) return
		setBusy(decision)
		setError(null)
		try {
			await actions.permit(ask, decision)
		} catch (e) {
			setError((e as Error).message)
			setBusy(null)
		}
	}
	const spin = (d: typeof busy, dark = false) => (busy === d ? <span className={`pt-spin pt-spin-xs${dark ? ' dark' : ''}`} /> : null)
	return (
		<div className="pt-asks">
			<div className="pt-b pt-q" role="group" aria-label="Permission request">
				<div className="pt-q-head">
					<KeyIcon />
					<span className="pt-q-title">Permission · {ask.action || 'tool'}</span>
				</div>
				<div className="pt-q-text pt-md" dangerouslySetInnerHTML={{ __html: markdownToHtml(ask.title) }} />
				{ask.save.length > 0 && (
					<div className="pt-q-note">
						Always allow lets it do <code>{ask.save.join(', ')}</code> from now on without asking.
					</div>
				)}
			</div>
			<div className="pt-b pt-act">
				{error ? (
					<span className="pt-act-h pt-fail" title={error}>
						{error}
					</span>
				) : (
					more > 0 && <span className="pt-act-h">{more} more after this</span>
				)}
				<span className="pt-sp" />
				<button className="pt-btn ghost" disabled={!!busy} onClick={() => reply('reject')}>
					{spin('reject') ?? 'Reject'}
				</button>
				<button className="pt-btn ghost" disabled={!!busy} onClick={() => reply('always')}>
					{spin('always') ?? 'Always allow'}
				</button>
				<button ref={onceRef} className="pt-btn pri" disabled={!!busy} onClick={() => reply('once')}>
					{spin('once', true) ?? 'Allow once'}
				</button>
			</div>
		</div>
	)
}

/** What viewers who can't answer see: that it's waiting, and on what. */
export function AskWaiting({ asking, loading }: { asking: AskingInfo; loading?: boolean }) {
	const what = asking.kind === 'permission' ? 'Permission request' : asking.count > 1 ? `${asking.count} questions` : 'Question'
	return (
		<div className="pt-asks">
			<div className="pt-b pt-q">
				<div className="pt-q-head">
					{asking.kind === 'permission' ? <KeyIcon /> : <QuestionIcon />}
					<span className="pt-q-title">{what}</span>
				</div>
				{asking.text && <div className="pt-q-text pt-md" dangerouslySetInnerHTML={{ __html: markdownToHtml(asking.text) }} />}
			</div>
			<div className="pt-b pt-ro">
				{loading ? <span className="pt-spin" /> : <span className="pt-dot" />}
				{loading ? 'Loading it…' : 'Waiting for the owner to answer'}
			</div>
		</div>
	)
}

function Option({ label, description, multi, on, disabled, onClick }: { label: string; description?: string; multi: boolean; on: boolean; disabled: boolean; onClick: () => void }) {
	return (
		<button className={`pt-q-opt${on ? ' on' : ''}`} role={multi ? 'checkbox' : 'radio'} aria-checked={on} disabled={disabled} onClick={onClick}>
			<span className={`pt-q-mark${multi ? ' sq' : ''}`} aria-hidden="true" />
			<span className="pt-q-opt-main">
				<span className="pt-q-opt-label">{label}</span>
				{description && description !== label && <span className="pt-q-opt-desc">{description}</span>}
			</span>
		</button>
	)
}

/** A field's answer from what's picked and typed, or undefined while it has none. */
function valueOf(f: AskField, d: Draft): AskValue | undefined {
	const text = d.text.trim()
	switch (f.type) {
		case 'boolean':
			return d.picked[0] === 'Yes' ? true : d.picked[0] === 'No' ? false : undefined
		case 'number':
		case 'integer': {
			const n = Number(text)
			return text && Number.isFinite(n) && (f.type === 'number' || Number.isInteger(n)) ? n : undefined
		}
		case 'text':
			return text || undefined
		case 'multi': {
			const all = [...d.picked, ...(d.custom && text ? [text] : [])]
			return all.length ? all : undefined
		}
		default:
			return d.custom ? text || undefined : d.picked[0]
	}
}

function QuestionIcon() {
	return (
		<svg className="pt-q-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<circle cx="12" cy="12" r="9.5" />
			<path d="M9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.4-2.7 4" />
			<path d="M12 17.4v.01" />
		</svg>
	)
}

function KeyIcon() {
	return (
		<svg className="pt-q-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<rect x="5" y="11" width="14" height="9" rx="2" />
			<path d="M8 11V8a4 4 0 0 1 8 0v3" />
		</svg>
	)
}
