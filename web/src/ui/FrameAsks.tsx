import { useLayoutEffect, useRef, useState } from 'react'
import { sessionColor } from '../../../shared/sessionColor'
import type { Editor } from '../editor/Editor'
import type { Attention } from '../multiplayer/Attention'
import type { SessionControl } from '../multiplayer/SessionControl'
import { AskBubbles, AskWaiting, useAsking, useSessionAsks } from './AskBubbles'
import { placeAtFrame, useFrameAnchor, type FrameAnchor } from './frameAnchor'
import { useValue } from './useValue'

/** off-screen chips stay this far inside the window, and below the top bar */
const CHIP_EDGE = 12
const CHIP_TOP = 72
const CHIP_W = 180
const CHIP_H = 30
const CARD_W = 360

/**
 * What sessions wait on their owner to answer (questions, permission requests), shown at their
 * frames as soon as they ask: to answer for the owner, read-only for everyone else. A session whose
 * frame is off screen gets a small chip at the screen's edge instead, toward the frame; clicking it
 * brings the frame into view. A card's × puts it away until the session asks something else (the
 * "?" badge on its frame's title brings it back). The session whose prompt is open shows them in
 * its prompt instead.
 */
export function FrameAsks({ editor, sessions, attention }: { editor: Editor; sessions: SessionControl; attention: Attention }) {
	const ids = useValue(() => {
		const prompting = sessions.prompting.get()
		return [...attention.asking.get().keys()].filter((id) => id !== prompting).join(' ')
	}, [sessions, attention])
	if (!ids) return null
	return (
		<>
			{ids.split(' ').map((id) => (
				<FrameAsk key={id} editor={editor} sessions={sessions} attention={attention} sessionId={id} />
			))}
		</>
	)
}

function FrameAsk({ editor, sessions, attention, sessionId }: { editor: Editor; sessions: SessionControl; attention: Attention; sessionId: string }) {
	const anchor = useFrameAnchor(editor, sessionId)
	const asking = useAsking(sessions, sessionId)
	const askingKey = asking ? JSON.stringify(asking) : ''
	const away = useValue(() => sessions.asksAway.get()[sessionId] === askingKey, [sessions, sessionId, askingKey])
	const name = useValue(() => sessions.label(sessionId), [sessions, sessionId])
	if (!asking || !anchor) return null
	const color = sessionColor(sessionId)
	if (!anchor.onScreen) return <EdgeChip anchor={anchor} color={color} name={name} onClick={() => attention.answer(sessionId)} />
	if (away) return null
	return <AskCard sessions={sessions} sessionId={sessionId} anchor={anchor} color={color} name={name} onAway={() => sessions.putAsksAway(sessionId, askingKey)} />
}

function AskCard({
	sessions,
	sessionId,
	anchor,
	color,
	name,
	onAway,
}: {
	sessions: SessionControl
	sessionId: string
	anchor: FrameAnchor
	color: string
	name: string
	onAway: () => void
}) {
	const owner = useValue(() => sessions.canPrompt && sessions.talkBlock(sessionId) === null, [sessions, sessionId])
	const asking = useAsking(sessions, sessionId)
	const { asks, loading, actions } = useSessionAsks(sessions, sessionId, owner, asking)
	const ref = useRef<HTMLDivElement>(null)
	const [size, setSize] = useState<{ w: number; h: number } | null>(null)
	useLayoutEffect(() => {
		const el = ref.current
		if (!el) return
		const measure = () => setSize((prev) => (prev && prev.w === el.offsetWidth && prev.h === el.offsetHeight ? prev : { w: el.offsetWidth, h: el.offsetHeight }))
		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(el)
		return () => observer.disconnect()
	}, [])
	if (!asking) return null
	const { left, top } = placeAtFrame(anchor, size?.w ?? CARD_W, size?.h ?? 0, window.innerWidth, window.innerHeight)
	const ctlSide = left + (size?.w ?? CARD_W) + 40 > window.innerWidth ? 'left' : 'right'
	return (
		<div
			ref={ref}
			className="pt frame-asks"
			style={{ left, top, ['--c' as string]: color, ['--ink' as string]: inkOn(color) }}
			role="dialog"
			aria-label={`${name} is waiting on an answer`}
			onPointerDown={(e) => e.stopPropagation()}
			onWheel={(e) => e.stopPropagation()}
			onKeyDown={(e) => {
				e.stopPropagation()
				if (e.key === 'Escape') onAway()
			}}
		>
			<div className="frame-asks-who">
				<i />
				<span>{name}</span>
			</div>
			{owner && asks?.length ? (
				<AskBubbles asks={asks} actions={actions} more={asks.length - 1} />
			) : (
				<AskWaiting asking={asking} loading={owner && loading} />
			)}
			<div className={`pt-ctl ${ctlSide}`}>
				<button className="pt-fb" title="Later (Esc): the ? on its frame brings it back" aria-label="Later" onClick={onAway}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
						<path d="M6 6l12 12M18 6 6 18" />
					</svg>
				</button>
			</div>
		</div>
	)
}

/** A chip at the screen's edge toward an off-screen frame whose session asks something. */
function EdgeChip({ anchor, color, name, onClick }: { anchor: FrameAnchor; color: string; name: string; onClick: () => void }) {
	const vw = window.innerWidth
	const vh = window.innerHeight
	const cx = (anchor.x + Math.max(anchor.x, Math.min(anchor.right, anchor.x + 400))) / 2
	const cy = (anchor.top + anchor.bottom) / 2
	const left = Math.round(Math.max(CHIP_EDGE, Math.min(cx - CHIP_W / 2, vw - CHIP_W - CHIP_EDGE)))
	const top = Math.round(Math.max(CHIP_TOP, Math.min(cy - CHIP_H / 2, vh - CHIP_H - CHIP_EDGE)))
	const angle = Math.atan2(cy - (top + CHIP_H / 2), cx - (left + CHIP_W / 2))
	return (
		<button
			className="frame-ask-chip"
			style={{ left, top, maxWidth: CHIP_W, ['--c' as string]: color, ['--ink' as string]: inkOn(color) }}
			title={`${name} is waiting on an answer: show it`}
			onPointerDown={(e) => e.stopPropagation()}
			onClick={onClick}
		>
			<span className="frame-ask-chip-q">?</span>
			<span className="frame-ask-chip-name">{name}</span>
			<span className="frame-ask-chip-arrow" style={{ transform: `rotate(${angle}rad)` }} aria-hidden="true">
				→
			</span>
		</button>
	)
}

/** Dark or white text, whichever reads better on a session colour. */
export function inkOn(hex: string) {
	const n = parseInt(hex.slice(1), 16)
	const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255)
	return 0.2126 * r * r + 0.7152 * g * g + 0.0722 * b * b > 0.18 ? '#0d0d0f' : '#ffffff'
}
