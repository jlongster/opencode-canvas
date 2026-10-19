import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Editor } from '../editor/Editor'
import type { Attention } from '../multiplayer/Attention'
import type { Conjure } from '../multiplayer/Conjure'
import type { Rails } from '../multiplayer/Rails'
import { framesPanelOpen } from './FramesPanel'
import { markdownToHtml } from './markdown'
import { useValue } from './useValue'

const PANEL_W = 320
/** keep the walkthrough this far inside the screen, and below the top bar */
const EDGE = 12
const TOP_EDGE = 64
const GAP = 16
/** how much of the rail must be on screen for the walkthrough to hang from it (screen px) */
const RAIL_MIN_W = 120

/**
 * "3 things want your attention" at the top of the screen while any session has something queued
 * (and isn't muted here), opening into a list of them; picking one brings the camera to its frame
 * and opens its walkthrough under the frame's rail.
 */
export function AttentionTray({ attention }: { attention: Attention }) {
	const callers = useValue(() => attention.callers.get(), [attention])
	// hidden frames have no rail to show it on: their rows open the frames list instead
	const hidden = useValue(() => callers.filter((c) => attention.editor.isSessionHidden(c.sessionId)).map((c) => c.sessionId).join(' '), [attention, callers])
	const [open, setOpen] = useState(false)
	useEffect(() => {
		if (!callers.length) setOpen(false)
	}, [callers.length])
	if (!callers.length) return null
	const total = callers.reduce((n, c) => n + c.actions.length, 0)
	const names = callers.map((c) => c.name)
	return (
		<div className={`attention-tray${open ? ' open' : ''}`} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
			<button className="attention-pill" aria-expanded={open} title={`From ${names.join(', ')}`} onClick={() => setOpen(!open)}>
				<span className="attention-dots" aria-hidden="true">
					{callers.slice(0, 4).map((c) => (
						<i key={c.sessionId} style={{ background: c.color }} />
					))}
				</span>
				<span className="attention-pill-text">
					{total} thing{total === 1 ? ' wants' : 's want'} your attention
					<span className="attention-pill-names">
						{' · '}
						{names[0]}
						{names.length > 1 ? ` +${names.length - 1}` : ''}
					</span>
				</span>
				<span className="attention-caret">{open ? '▴' : '▾'}</span>
			</button>
			{open && (
				<div className="attention-list">
					{callers.map((c) => (
						<button
							key={c.sessionId}
							className="attention-row"
							style={{ ['--agent-color' as string]: c.color }}
							title={hidden.includes(c.sessionId) ? 'Its frame is hidden: show it from the frames list' : undefined}
							onClick={() => {
								setOpen(false)
								if (hidden.includes(c.sessionId)) framesPanelOpen.set(true)
								else attention.open(c.sessionId, { fromTray: true })
							}}
						>
							<i className="attention-row-dot" />
							<span className="attention-row-main">
								<span className="attention-row-name">
									{c.name}
									{hidden.includes(c.sessionId) && <span className="attention-row-hidden"> (hidden)</span>}
								</span>
								<span className="attention-row-preview">{c.actions[0] ? attention.preview(c.actions[0]) : ''}</span>
							</span>
							<span className="attention-row-count">{c.actions.length}</span>
						</button>
					))}
				</div>
			)}
		</div>
	)
}

/**
 * The walkthrough of a session's queue: the current step's message in the session's colour, with
 * Back / Next (Done on the last) and Dismiss all. It hangs from the frame's status rail (the pinned
 * rail when the frame's top is off screen) while the rail is on screen (see place); when a highlight
 * takes the camera somewhere the frame isn't, or hanging there would cover the target, it docks
 * beside the highlighted target instead (else at the top of the screen), so it's always in reach.
 * The highlighted target gets a pulsing outline.
 */
export function Walkthrough({ editor, attention, conjure, rails }: { editor: Editor; attention: Attention; conjure: Conjure; rails: Rails }) {
	const walk = useValue(() => attention.walk.get(), [attention])
	const caller = useValue(() => {
		const w = attention.walk.get()
		return w ? (attention.callers.get().find((c) => c.sessionId === w.sessionId) ?? null) : null
	}, [attention])
	const doneIds = useValue(() => {
		const w = attention.walk.get()
		return w ? w.steps.filter((s) => !attention.queued(s.id)).map((s) => s.id).join(' ') : ''
	}, [attention])
	const canPrompt = useValue(() => {
		const w = attention.walk.get()
		return !!w && conjure.canPrompt && conjure.talkBlock(w.sessionId) === null
	}, [attention, conjure])
	// Where the rail and the target are on screen, as a string so this only re-renders when they move.
	const geometry = useValue(() => {
		const w = attention.walk.get()
		if (!w) return ''
		editor.camera.get()
		const { w: vw, h: vh } = editor.viewport.get()
		editor.layout.get()
		editor.noteBoxes.get()
		const step = w.steps[w.index]
		const rail = rails.box(w.sessionId)
		const c = rail && rail.w >= RAIL_MIN_W ? { x: rail.x, y: rail.y, w: rail.w, h: rail.h } : null
		const box = step?.kind === 'highlight' && step.target ? attention.targetBox(step.target) : undefined
		const t = box ? { ...editor.pageToScreen(box), w: box.w * editor.camera.get().z, h: box.h * editor.camera.get().z } : null
		return JSON.stringify({ c, t, vw, vh })
	}, [editor, attention, rails])
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
	const { c, t, vw, vh } = JSON.parse(geometry) as {
		c: Rect | null
		t: { x: number; y: number; w: number; h: number } | null
		vw: number
		vh: number
	}
	const color = caller?.color ?? conjure.status(walk.sessionId)?.color ?? '#a78bfa'
	const name = caller?.name ?? attention.name(walk.sessionId)
	const last = walk.index >= walk.steps.length - 1
	const done = doneIds.split(' ').includes(step.id)
	const missing = step.kind === 'highlight' && !t

	const { left, top, docked } = place(c, t, vw, vh, height)
	const text = step.text ?? (step.kind === 'highlight' && step.target ? `Have a look at ${attention.targetLabel(step.target)}.` : '')
	const prompt = () => {
		attention.close()
		conjure.openDialog(walk.sessionId)
	}

	return (
		<>
			{t && (
				<div
					key={step.id}
					className="attention-highlight"
					style={{ left: t.x, top: t.y, width: t.w, height: t.h, ['--agent-color' as string]: color }}
					aria-hidden="true"
				/>
			)}
			<div
				ref={panelRef}
				className={`walkthrough docked-${docked}`}
				role="dialog"
				aria-label={`${name}: step ${walk.index + 1} of ${walk.steps.length}`}
				style={{ left, top, width: PANEL_W, ['--agent-color' as string]: color }}
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
						title={docked === 'rail' ? name : `Go back to ${name}`}
						onClick={() => attention.revealFrame(walk.sessionId)}
					>
						<i />
						<span>{name}</span>
						{docked !== 'rail' && <span className="walkthrough-locate">↩</span>}
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
						<button
							className="walkthrough-target"
							disabled={missing}
							title={missing ? undefined : 'Show it again'}
							onClick={() => attention.showStep()}
						>
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
						<button className="walkthrough-quiet" title={`Talk to ${name}`} onClick={prompt}>
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

/**
 * Where the walkthrough goes: hanging from the rail while it's on screen, unless that covers the
 * highlighted target; then beside the target; else at the top of the screen. Always kept on screen.
 */
function place(c: Rect | null, t: Rect | null, vw: number, vh: number, h: number) {
	const w = PANEL_W
	const fits = (r: Rect) => r.x >= EDGE && r.y >= TOP_EDGE && r.x + r.w <= vw - EDGE && r.y + r.h <= vh - EDGE
	const clampX = (x: number) => Math.min(Math.max(x, EDGE), vw - w - EDGE)
	const clampY = (y: number) => Math.min(Math.max(y, TOP_EDGE), vh - h - EDGE)
	const candidates: { r: Rect; docked: 'rail' | 'target' }[] = []
	if (c) {
		candidates.push({ r: { x: clampX(c.x + 8), y: c.y + c.h + 8, w, h }, docked: 'rail' })
		candidates.push({ r: { x: clampX(c.x + c.w - w - 8), y: c.y + c.h + 8, w, h }, docked: 'rail' })
	}
	if (t) {
		candidates.push({ r: { x: t.x + t.w + GAP, y: clampY(t.y), w, h }, docked: 'target' })
		candidates.push({ r: { x: t.x - GAP - w, y: clampY(t.y), w, h }, docked: 'target' })
		candidates.push({ r: { x: clampX(t.x), y: t.y + t.h + GAP, w, h }, docked: 'target' })
		candidates.push({ r: { x: clampX(t.x), y: t.y - GAP - h, w, h }, docked: 'target' })
	}
	const best = candidates.find((k) => fits(k.r) && (!t || !overlaps(k.r, t)))
	if (best) return { left: Math.round(best.r.x), top: Math.round(best.r.y), docked: best.docked }
	// Nothing fits clear of everything: under the rail if it's here, else by the target, else at the top.
	if (c) return { left: Math.round(clampX(c.x + 8)), top: Math.round(clampY(c.y + c.h + 8)), docked: 'rail' as const }
	if (t) return { left: Math.round(clampX(t.x + t.w + GAP)), top: Math.round(clampY(t.y)), docked: 'target' as const }
	return { left: Math.round(clampX(vw / 2 - w / 2)), top: Math.round(clampY(TOP_EDGE + 40)), docked: 'edge' as const }
}
