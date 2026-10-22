import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { sessionColor } from '../../../shared/sessionColor'
import type { AttentionAction } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import { Box } from '../editor/geometry'
import type { Attention } from '../multiplayer/Attention'
import type { AskingInfo } from '../multiplayer/Presence'
import type { SessionControl } from '../multiplayer/SessionControl'
import { inkOn } from './FrameAsks'
import { frameAnchor, placeAtFrame, type FrameAnchor } from './frameAnchor'
import { framesPanelOpen } from './FramesPanel'
import { markdownToHtml } from './markdown'
import { useValue } from './useValue'

const PANEL_W = 320
/** keep the walkthrough this far inside the screen, and below the top bar */
const EDGE = 12
const TOP_EDGE = 64
const GAP = 16
/** room kept clear around an exact spot, so the card never covers it (screen px) */
const SPOT_ROOM = 28

/**
 * "3 things want your attention" at the top of the screen while any session has something queued
 * or asks something, opening into a list of them; picking one brings its frame into view and opens
 * its walkthrough (or shows what it asks).
 */
export function AttentionTray({ attention }: { attention: Attention }) {
	const callers = useValue(() => attention.callers.get(), [attention])
	// hidden frames can't be shown: their rows open the frames list instead
	const hidden = useValue(() => callers.filter((c) => attention.editor.isSessionHidden(c.sessionId)).map((c) => c.sessionId).join(' '), [attention, callers])
	const [open, setOpen] = useState(false)
	useEffect(() => {
		if (!callers.length) setOpen(false)
	}, [callers.length])
	if (!callers.length) return null
	const total = callers.reduce((n, c) => n + c.actions.length + (c.asking?.count ?? 0), 0)
	const names = callers.map((c) => c.name)
	const askers = callers.filter((c) => c.asking)
	const lone = askers.length === 1 && callers.length === 1
	const headline = lone ? `${askers[0].name} ${asks(askers[0].asking!)}` : `${total} thing${total === 1 ? ' wants' : 's want'} your attention`
	return (
		<div className={`attention-tray${open ? ' open' : ''}`} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
			<button className="attention-pill" aria-expanded={open} title={`From ${names.join(', ')}`} onClick={() => setOpen(!open)}>
				<span className="attention-dots" aria-hidden="true">
					{callers.slice(0, 4).map((c) => (
						<i key={c.sessionId} style={{ background: c.color }} />
					))}
				</span>
				<span className="attention-pill-text">
					{headline}
					{!lone && (
						<span className="attention-pill-names">
							{' · '}
							{names[0]}
							{names.length > 1 ? ` +${names.length - 1}` : ''}
						</span>
					)}
				</span>
				<span className="attention-caret">{open ? '▴' : '▾'}</span>
			</button>
			{open && (
				<div className="attention-list">
					{callers.map((c) => (
						<button
							key={c.sessionId}
							className={`attention-row${c.asking ? ' asking' : ''}`}
							style={{ ['--agent-color' as string]: c.color }}
							title={hidden.includes(c.sessionId) ? 'Its frame is hidden: show it from the frames list' : undefined}
							onClick={() => {
								setOpen(false)
								if (hidden.includes(c.sessionId)) framesPanelOpen.set(true)
								else if (c.asking) attention.answer(c.sessionId)
								else attention.open(c.sessionId, { fromTray: true })
							}}
						>
							<i className="attention-row-dot" />
							<span className="attention-row-main">
								<span className="attention-row-name">
									{c.name}
									{hidden.includes(c.sessionId) && <span className="attention-row-hidden"> (hidden)</span>}
								</span>
								<span className="attention-row-preview">
									{c.asking ? `${capital(asks(c.asking))}${c.asking.text ? `: ${c.asking.text}` : ''}` : preview(attention, c.actions[0])}
								</span>
							</span>
							<span className="attention-row-count">{c.asking ? '?' : c.actions.length}</span>
						</button>
					))}
				</div>
			)}
		</div>
	)
}

/**
 * The walkthrough of a session's queue, one step at a time, with Back / Next (Done on the last),
 * Prompt and Dismiss all. A say step is a message card at the session's frame, above its title (or
 * just under it without room above). A highlight step glides the camera to its target and outlines
 * it crisply in the session's colour (an exact spot: a ring on a point, or an outline round a
 * region), with its card beside the target, clear of it.
 */
export function Walkthrough({ editor, attention, sessions }: { editor: Editor; attention: Attention; sessions: SessionControl }) {
	const walk = useValue(() => attention.walk.get(), [attention])
	const name = useValue(() => {
		const w = attention.walk.get()
		return w ? sessions.label(w.sessionId) : ''
	}, [attention, sessions])
	const doneIds = useValue(() => {
		const w = attention.walk.get()
		return w ? w.steps.filter((s) => !attention.queued(s.id)).map((s) => s.id).join(' ') : ''
	}, [attention])
	const canPrompt = useValue(() => {
		const w = attention.walk.get()
		return !!w && sessions.canOpen(w.sessionId)
	}, [attention, sessions])
	// Where the frame and the target are on screen, as a string so this only re-renders when they move.
	const geometry = useValue(() => {
		const w = attention.walk.get()
		if (!w) return ''
		const z = editor.camera.get().z
		const { w: vw, h: vh } = editor.viewport.get()
		editor.noteBoxes.get()
		const step = w.steps[w.index]
		const a = frameAnchor(editor, w.sessionId)
		const box = step?.kind === 'highlight' && step.target ? attention.targetBox(step.target) : undefined
		const t = box ? { ...editor.pageToScreen(box), w: box.w * z, h: box.h * z } : null
		const focus = attention.focusOf(step)
		const f = focus ? { kind: focus.kind, ...editor.pageToScreen(focus.box), w: focus.box.w * z, h: focus.box.h * z } : null
		return JSON.stringify({ a, t, f, vw, vh })
	}, [editor, attention])
	const panelRef = useRef<HTMLDivElement>(null)
	const nextRef = useRef<HTMLButtonElement>(null)
	const [height, setHeight] = useState(180)

	useLayoutEffect(() => {
		const h = panelRef.current?.offsetHeight
		if (h && Math.abs(h - height) > 1) setHeight(h)
	})
	useEffect(() => {
		nextRef.current?.focus({ preventScroll: true })
	}, [walk?.sessionId, walk?.index])

	if (!walk || !geometry) return null
	const step = walk.steps[walk.index]
	if (!step) return null
	const { a, t, f, vw, vh } = JSON.parse(geometry) as {
		a: FrameAnchor | null
		t: Rect | null
		/** the step's exact spot, if it has one: only it is outlined, and the card keeps clear of it */
		f: (Rect & { kind: 'point' | 'region' }) | null
		vw: number
		vh: number
	}
	const color = sessionColor(walk.sessionId)
	const last = walk.index >= walk.steps.length - 1
	const done = doneIds.split(' ').includes(step.id)
	const missing = step.kind === 'highlight' && !t
	const highlight = step.kind === 'highlight' && !!t

	const spot = f && Box.expand(f, SPOT_ROOM)
	const { left, top, at } = highlight ? besideTarget(spot ?? t!, a, vw, vh, height) : atFrame(a, vw, vh, height)
	const text = step.text ?? (step.kind === 'highlight' && step.target ? `Have a look at ${attention.targetLabel(step.target)}.` : '')
	const prompt = () => {
		attention.close()
		sessions.toggle(walk.sessionId)
	}
	const style = { ['--agent-color' as string]: color, ['--agent-ink' as string]: inkOn(color) }

	return (
		<>
			{highlight && f?.kind === 'point' && <div key={step.id} className="attention-point" style={{ left: f.x, top: f.y, ...style }} aria-hidden="true" />}
			{highlight && f?.kind === 'region' && (
				<div key={step.id} className="attention-outline region" style={{ left: f.x, top: f.y, width: f.w, height: f.h, ...style }} aria-hidden="true" />
			)}
			{highlight && !f && (
				<div key={step.id} className="attention-outline" style={{ left: t!.x, top: t!.y, width: t!.w, height: t!.h, ...style }} aria-hidden="true" />
			)}
			<div
				ref={panelRef}
				className={`walkthrough at-${at}`}
				role="dialog"
				aria-label={`${name}: step ${walk.index + 1} of ${walk.steps.length}`}
				style={{ left, top, width: PANEL_W, ...style }}
				onPointerDown={(e) => e.stopPropagation()}
				onWheel={(e) => e.stopPropagation()}
				onDoubleClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => {
					e.stopPropagation()
					if (e.key === 'Escape') attention.close()
					else if (e.key === 'ArrowRight') attention.next()
					else if (e.key === 'ArrowLeft') attention.back()
				}}
			>
				<div className="walkthrough-head">
					<button
						className="walkthrough-who"
						title={a?.onScreen ? name : `Show ${name}’s frame`}
						disabled={!a}
						onClick={() => attention.revealFrame(walk.sessionId)}
					>
						<i />
						<span>{name}</span>
						{a && !a.onScreen && <span className="walkthrough-locate">↩</span>}
					</button>
					<span className="walkthrough-step">
						{done && <span className="walkthrough-done">✓ </span>}
						{walk.index + 1}/{walk.steps.length}
					</span>
					<button className="walkthrough-close" title="Close (Esc)" onClick={() => attention.close()}>
						×
					</button>
				</div>
				<div key={step.id} className="walkthrough-bubble">
					{step.kind === 'highlight' && (
						<button className="walkthrough-target" disabled={missing} title={missing ? undefined : 'Show it again'} onClick={() => attention.showStep()}>
							{missing ? 'It is no longer on the canvas' : `◎ ${attention.targetLabel(step.target!)}`}
						</button>
					)}
					{text && <div className="walkthrough-text md-text" dangerouslySetInnerHTML={{ __html: markdownToHtml(text) }} />}
				</div>
				<div className="walkthrough-actions">
					<button disabled={walk.index === 0} onClick={() => attention.back()}>
						Back
					</button>
					<button ref={nextRef} className="walkthrough-next" onClick={() => attention.next()}>
						{last ? 'Done' : 'Next'}
					</button>
					<span className="walkthrough-spacer" />
					{canPrompt && (
						<button className="walkthrough-quiet" title={`Prompt ${name}`} onClick={prompt}>
							Prompt
						</button>
					)}
					{attention.canEdit && (
						<button className="walkthrough-quiet" title="Mark everything it queued as done" onClick={() => attention.dismissAll()}>
							Dismiss all
						</button>
					)}
				</div>
				{!attention.canEdit && <div className="walkthrough-note">View only: stepping through doesn't mark anything done.</div>}
			</div>
		</>
	)
}

type Rect = { x: number; y: number; w: number; h: number }

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** A say step's card: at the session's frame (see placeAtFrame), else at the top of the screen. */
function atFrame(a: FrameAnchor | null, vw: number, vh: number, h: number) {
	if (a) return { ...placeAtFrame(a, PANEL_W, h, vw, vh), at: 'frame' as const }
	return { left: Math.round(Math.max(EDGE, (vw - PANEL_W) / 2)), top: TOP_EDGE + 56, at: 'edge' as const }
}

/**
 * A highlight step's card: beside the target (right, left, below, above), clear of it; failing
 * that, at the session's frame if that's clear of it; else clamped onto the screen beside it.
 */
function besideTarget(t: Rect, a: FrameAnchor | null, vw: number, vh: number, h: number) {
	const w = PANEL_W
	const fits = (r: Rect) => r.x >= EDGE && r.y >= TOP_EDGE && r.x + r.w <= vw - EDGE && r.y + r.h <= vh - EDGE
	const clampX = (x: number) => Math.min(Math.max(x, EDGE), vw - w - EDGE)
	const clampY = (y: number) => Math.min(Math.max(y, TOP_EDGE), vh - h - EDGE)
	const candidates: Rect[] = [
		{ x: t.x + t.w + GAP, y: clampY(t.y), w, h },
		{ x: t.x - GAP - w, y: clampY(t.y), w, h },
		{ x: clampX(t.x), y: t.y + t.h + GAP, w, h },
		{ x: clampX(t.x), y: t.y - GAP - h, w, h },
	]
	const best = candidates.find((r) => fits(r) && !overlaps(r, t))
	if (best) return { left: Math.round(best.x), top: Math.round(best.y), at: 'target' as const }
	if (a?.onScreen) {
		const p = placeAtFrame(a, w, h, vw, vh)
		if (!overlaps({ x: p.left, y: p.top, w, h }, t)) return { ...p, at: 'frame' as const }
	}
	return { left: Math.round(clampX(t.x + t.w + GAP)), top: Math.round(clampY(t.y)), at: 'target' as const }
}

/** "is asking a question", "needs your permission" and the like. */
function asks(asking: AskingInfo): string {
	if (asking.kind === 'permission') return asking.count > 1 ? `needs your permission (${asking.count})` : 'needs your permission'
	return asking.count > 1 ? `is asking ${asking.count} questions` : 'is asking a question'
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The first line of an action, as plain text, for the tray. */
function preview(attention: Attention, action: AttentionAction | undefined): string {
	if (!action) return ''
	const text = (action.text ?? '')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[`*_~#>]+/g, '')
		.replace(/\s+/g, ' ')
		.trim()
	if (action.kind === 'highlight' && action.target) {
		const what = `Look at ${attention.targetLabel(action.target)}`
		return text ? `${what}: ${text}` : what
	}
	return text
}
