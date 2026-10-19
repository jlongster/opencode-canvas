import type { AttentionAction } from '../../../shared/types'
import { GROUP_OUTLINE_PADDING, type Editor } from '../editor/Editor'
import { Box } from '../editor/geometry'
import { parseSelectionId } from '../editor/selection'
import { atom, computed, react, type Atom } from '../state/signals'
import { clearActions, markActionDone } from '../sync/client'
import { plainLine } from '../ui/rail'
import type { Conjure } from './Conjure'

/** A session's walkthrough of its queue, open here. */
export interface Walk {
	sessionId: string
	/** the queue as it was when opened, plus whatever was queued since; done steps stay so Back can show them */
	steps: AttentionAction[]
	index: number
}

/** One session calling for attention, as the tray lists it. */
export interface Caller {
	sessionId: string
	name: string
	color: string
	actions: AttentionAction[]
}

/** room (screen px) kept around a highlighted target when the camera brings it into view */
const REVEAL_PAD = 96
/** what's along the top of the screen (the top bar and the attention tray), kept clear when revealing */
const TOP_INSET = 116
/** the part of a frame brought into view for its walkthrough: its rail and room for the walkthrough under it (screen px) */
const FRAME_VIEW = { w: 420, h: 320 }

/**
 * Attention queues on a canvas (see server/attention.ts): what each session wants people to look
 * at. The count on its frame's status rail and the tray at the top show what's waiting; opening one
 * plays its queue as a walkthrough anchored to the rail. Each highlight step outlines its target and
 * slides the camera just enough to show it; say steps never move the camera.
 *
 * On edit links, stepping past an action marks it done for everyone (it leaves the queue); view
 * links step through the same queue read-only.
 */
export class Attention {
	readonly walk = atom<Walk | null>('attentionWalk', null)
	/** when the current step started, for the highlight's pulse */
	stepAt = 0
	/** queued actions by session, oldest first */
	readonly bySession = computed<Map<string, AttentionAction[]>>('attentionBySession', () => {
		const map = new Map<string, AttentionAction[]>()
		for (const a of this.queue.get()) {
			let list = map.get(a.sessionId)
			if (!list) map.set(a.sessionId, (list = []))
			list.push(a)
		}
		return map
	})
	/** sessions with something queued (and not muted here), in the order they first asked */
	readonly callers = computed<Caller[]>('attentionCallers', () => {
		const muted = this.conjure.muted.get()
		return [...this.bySession.get()]
			.filter(([sessionId]) => !muted.has(sessionId))
			.map(([sessionId, actions]) => ({ sessionId, name: this.name(sessionId), color: this.conjure.status(sessionId)?.color ?? '#a78bfa', actions }))
	})
	private disposers: (() => void)[] = []

	constructor(
		readonly editor: Editor,
		readonly conjure: Conjure,
		readonly canvasId: string,
		/** edit links mark steps done; view links only step through */
		readonly canEdit: boolean,
		/** the canvas's queued actions, from the server (live) */
		readonly queue: Atom<AttentionAction[]>,
	) {
		// Steps queued while a walkthrough is open join its end.
		this.disposers.push(
			react(() => {
				const queued = this.bySession.get()
				const walk = this.walk.peek()
				if (!walk) return
				const fresh = (queued.get(walk.sessionId) ?? []).filter((a) => !walk.steps.some((s) => s.id === a.id))
				if (fresh.length) this.walk.set({ ...walk, steps: [...walk.steps, ...fresh] })
			}),
		)
	}

	/** How many actions the session has queued (reactive). */
	count(sessionId: string) {
		return this.bySession.get().get(sessionId)?.length ?? 0
	}

	/** Whether an action is still queued (not yet done by anyone). */
	queued(id: string) {
		return this.queue.get().some((a) => a.id === id)
	}

	isOpen(sessionId: string) {
		return this.walk.peek()?.sessionId === sessionId
	}

	/** A session's name: its frame's title, else its conjured record's, else a short id. */
	name(sessionId: string): string {
		const s = this.editor.sessions.get()[sessionId]
		if (s && s.title.trim() && s.title !== s.id) return s.title
		return this.conjure.status(sessionId)?.title || `ses_…${sessionId.slice(-6)}`
	}

	/**
	 * Opens the session's walkthrough at its first queued step, anchored to its frame's rail. From
	 * the tray, the camera first brings the frame's top into view (unless the first step shows
	 * something else).
	 */
	open(sessionId: string, opts: { fromTray?: boolean; fromRail?: boolean } = {}) {
		const steps = this.bySession.get().get(sessionId) ?? []
		if (!steps.length) return
		this.conjure.closeDialog()
		this.walk.set({ sessionId, steps: [...steps], index: 0 })
		const first = this.showStep()
		if (opts.fromTray && !first) this.revealFrame(sessionId)
	}

	close() {
		this.walk.set(null)
	}

	/** Marks the current step done (edit links) and moves on; past the last one, closes. */
	next() {
		const walk = this.walk.peek()
		if (!walk) return
		this.markDone(walk.steps[walk.index])
		if (walk.index >= walk.steps.length - 1) return this.close()
		this.walk.set({ ...walk, index: walk.index + 1 })
		this.showStep()
	}

	back() {
		const walk = this.walk.peek()
		if (!walk || walk.index === 0) return
		this.walk.set({ ...walk, index: walk.index - 1 })
		this.showStep()
	}

	/** Clears the session's whole queue for everyone (edit links) and closes. */
	dismissAll() {
		const walk = this.walk.peek()
		if (!walk) return
		this.close()
		if (this.canEdit) clearActions(this.canvasId, walk.sessionId).catch((e) => console.error('dismissing failed', e))
	}

	/** The current step, if a walkthrough is open. */
	current(): AttentionAction | null {
		const walk = this.walk.get()
		return walk ? (walk.steps[walk.index] ?? null) : null
	}

	/** A highlight target's page box (groups with their outline's padding), if it's still on the canvas. */
	targetBox(target: string): Box | undefined {
		const { kind, id } = parseSelectionId(target)
		if (kind === 'group') {
			const group = this.editor.layout.get().groups.find((g) => g.id === id)
			return group && Box.expand(group.box, GROUP_OUTLINE_PADDING)
		}
		if (kind === 'item') return this.editor.getItemBoundsWithTitle(id)
		return this.editor.getSelectionBounds(target)
	}

	/** A short name for a highlight target, for previews. */
	targetLabel(target: string): string {
		const { kind, id } = parseSelectionId(target)
		if (kind === 'group') return `the group “${id.slice(id.indexOf('/') + 1) || 'Untitled'}”`
		if (kind === 'frame') {
			const s = this.editor.sessions.get()[id]
			return s?.title.trim() && s.title !== s.id ? `the session “${s.title}”` : 'the session'
		}
		if (kind === 'note') return 'a sticky note'
		const item = this.editor.items.get()[id]
		return item ? `“${item.title || item.name}”` : 'an item'
	}

	/** Brings the current step's target into view. True if it moved the camera there (a highlight). */
	showStep(): boolean {
		this.stepAt = performance.now()
		const step = this.current()
		if (step?.kind !== 'highlight' || !step.target) return false
		const box = this.targetBox(step.target)
		if (!box) return false
		this.reveal(box, REVEAL_PAD)
		return true
	}

	/**
	 * Slides the camera to bring the frame's top-left (its rail, and room for the walkthrough under
	 * it) into view. Already on screen with its rail showing (pinned or not), it stays put.
	 */
	revealFrame(sessionId: string) {
		const section = this.editor.layout.get().sections.find((s) => s.id === sessionId)
		if (!section) return
		const z = this.editor.camera.peek().z
		const { w: vw, h: vh } = this.editor.viewport.peek()
		const view = this.editor.viewportPageBounds.get()
		const box = section.box
		// Well on screen already: its rail is showing (pinned if need be), with room under it.
		const ow = (Math.min(box.x + box.w, view.x + view.w) - Math.max(box.x, view.x)) * z
		const oh = (Math.min(box.y + box.h, view.y + view.h) - Math.max(box.y, view.y)) * z
		if (ow >= Math.min(FRAME_VIEW.w, box.w * z, vw / 2) && oh >= Math.min(FRAME_VIEW.h, box.h * z, vh / 2)) return
		this.reveal({ x: box.x, y: box.y, w: Math.min(box.w, FRAME_VIEW.w / z), h: Math.min(box.h, FRAME_VIEW.h / z) }, 24)
	}

	/** The first line of an action, as plain text, for the tray and the rail. */
	preview(action: AttentionAction): string {
		const text = plainLine(action.text ?? '')
		if (action.kind === 'highlight' && action.target) {
			const what = `Look at ${this.targetLabel(action.target)}`
			return text ? `${what}: ${text}` : what
		}
		return text
	}

	/**
	 * The smallest camera move that shows the box with `pad` screen px around it: a pan at the
	 * current zoom, or zoomed out to fit if it's too big for the screen at this zoom.
	 */
	reveal(box: Box, pad: number) {
		const editor = this.editor
		const cam = editor.camera.peek()
		const { w, h } = editor.viewport.peek()
		const p = Math.min(pad, w / 6, h / 6)
		const top = Math.min(Math.max(p, TOP_INSET), h / 4)
		const fit = Math.min((w - p * 2) / box.w, (h - p - top) / box.h)
		if (fit < cam.z) {
			// Fit it between the top bar and the bottom, centred.
			const z = Math.max(fit, 0.02)
			editor.stopCameraMotion()
			editor.setCamera(
				{ x: w / 2 / z - (box.x + box.w / 2), y: (top + (h - p - top) / 2) / z - (box.y + box.h / 2), z },
				{ animate: true },
			)
			return
		}
		const z = cam.z
		const view = { x: -cam.x, y: -cam.y, w: w / z, h: h / z }
		const shift = (lo: number, size: number, vLo: number, vSize: number, padLo: number, padHi: number) =>
			lo - padLo < vLo ? lo - padLo - vLo : lo + size + padHi > vLo + vSize ? lo + size + padHi - (vLo + vSize) : 0
		const dx = shift(box.x, box.w, view.x, view.w, p / z, p / z)
		const dy = shift(box.y, box.h, view.y, view.h, top / z, p / z)
		if (!dx && !dy) return
		editor.stopCameraMotion()
		editor.setCamera({ x: cam.x - dx, y: cam.y - dy, z }, { animate: true })
	}

	private markDone(step: AttentionAction | undefined) {
		if (!step || !this.canEdit || !this.queue.peek().some((a) => a.id === step.id)) return
		// Gone here right away; the server's event confirms it (and tells everyone else).
		this.queue.set(this.queue.peek().filter((a) => a.id !== step.id))
		markActionDone(this.canvasId, step.sessionId, step.id).catch((e) => console.error('marking done failed', e))
	}

	destroy() {
		for (const d of this.disposers.splice(0)) d()
	}
}
