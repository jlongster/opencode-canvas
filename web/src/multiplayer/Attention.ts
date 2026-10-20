import type { AttentionAction } from '../../../shared/types'
import { FOCUS_MAX_WIDTH, FOCUS_MAX_ZOOM, GROUP_OUTLINE_PADDING, type Editor } from '../editor/Editor'
import { Box, type Vec } from '../editor/geometry'
import { parseSelectionId } from '../editor/selection'
import { atom, computed, react, type Atom } from '../state/signals'
import { clearActions, markActionDone } from '../sync/client'
import type { Conjure } from './Conjure'
import type { AskingInfo } from './Presence'
import { wormName } from './WormHost'

/** A creature's walkthrough of its queue, open here. */
export interface Walk {
	sessionId: string
	/** the queue as it was when opened, plus whatever was queued since; done steps stay so Back can show them */
	steps: AttentionAction[]
	index: number
}

/**
 * A highlight step's exact spot on the page: a point (box of no size) or a region, and the box of
 * what it's on (the item, or the frame / group / note for "at").
 */
export interface Focus {
	kind: 'point' | 'region'
	box: Box
	within: Box | undefined
}

/** One creature calling for attention, as the tray lists it. */
export interface Caller {
	sessionId: string
	name: string
	color: string
	actions: AttentionAction[]
	/** its session waits on its owner to answer questions or permission requests (see WormHost) */
	asking: AskingInfo | null
}

/** room (screen px) kept around a highlighted target when the camera brings it into view */
const REVEAL_PAD = 96
/** what's along the top of the screen (the top bar and the attention tray), kept clear when revealing */
const TOP_INSET = 116
/** the part of the screen around a creature brought into view: it, its name and the walkthrough beside it */
const CREATURE_VIEW = { left: 70, top: 70, right: 400, bottom: 300 }
/** how long the camera glides to a step's exact spot (ms) */
const FOCUS_GLIDE_MS = 560
/** a region is zoomed to at least this big on screen (its longer side, screen px)... */
const REGION_MIN_PX = 200
/** ...and at most this share of the room on screen */
const REGION_MAX_SHARE = 0.7
/** an item pointed into is zoomed to at least this big on screen (its longer side, screen px) */
const POINT_CONTEXT_PX = 480
/** a spot this close to the screen's edge (share of the smaller side) gets centred */
const EDGE_SHARE = 0.14

/**
 * Attention queues on a canvas (see server/attention.ts): what each session's creature wants people
 * to look at. The badge on a creature and the tray at the top show what's waiting; opening one plays
 * its queue as a walkthrough beside the creature. Each highlight step outlines its target and slides
 * the camera just enough to show it, or, with an exact spot (a point or region), glides the camera
 * to that spot and marks only it; say steps never move the camera.
 *
 * On edit links, stepping past an action marks it done for everyone (it leaves the queue); view
 * links step through the same queue read-only.
 */
export class Attention {
	readonly walk = atom<Walk | null>('attentionWalk', null)
	/** when the current step started, for the highlight's pulse */
	stepAt = 0
	/**
	 * The zoom the camera settles at for the current step (where it went, or stayed): the pointer
	 * stands off an exact spot by its size at this zoom, worked out once so zooming doesn't move it.
	 */
	stepZoom = 1
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
	/** what each conjured creature's session is asking its owner, by session (from their presence) */
	readonly asking = computed<Map<string, AskingInfo>>('attentionAsking', () => {
		const map = new Map<string, AskingInfo>()
		for (const p of this.conjure.presence.peers.get()) if (p.user.conjured && p.user.sessionId && p.asking?.count) map.set(p.user.sessionId, p.asking)
		return map
	})
	/** creatures asking something first, then those with something queued, in the order they first asked */
	readonly callers = computed<Caller[]>('attentionCallers', () => {
		const records = this.conjure.records.get()
		const asking = this.asking.get()
		const queued = this.bySession.get()
		return [...new Set([...asking.keys(), ...queued.keys()])].map((sessionId) => {
			const r = records.find((x) => x.sessionId === sessionId)
			return {
				sessionId,
				name: r ? wormName(r) : `ses_…${sessionId.slice(-6)}`,
				color: r?.color ?? '#a78bfa',
				actions: queued.get(sessionId) ?? [],
				asking: asking.get(sessionId) ?? null,
			}
		})
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

	/** How many actions the session's creature has queued (reactive). */
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

	/**
	 * Opens the creature's walkthrough at its first queued step. From the tray, the camera first
	 * brings the creature into view (unless the first step shows something else).
	 */
	open(sessionId: string, opts: { fromTray?: boolean } = {}) {
		const steps = this.bySession.get().get(sessionId) ?? []
		if (!steps.length) return
		this.conjure.close()
		this.walk.set({ sessionId, steps: [...steps], index: 0 })
		const first = this.showStep()
		if (opts.fromTray && !first) this.revealCreature(sessionId)
	}

	close() {
		this.walk.set(null)
	}

	/**
	 * A creature asking its owner something: brings it into view (from the tray) and opens its stack,
	 * which shows the questions (to its owner; read-only to everyone else on an edit link).
	 */
	answer(sessionId: string, opts: { fromTray?: boolean } = {}) {
		this.close()
		if (opts.fromTray) this.revealCreature(sessionId)
		const peer = this.conjure.worms().find((p) => p.user.sessionId === sessionId)
		if (peer) this.conjure.open(peer)
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

	/** Clears the creature's whole queue for everyone (edit links) and closes. */
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

	/** Where the creature is on the page: its live presence, else its record. */
	creatureAt(sessionId: string): Vec | null {
		const peer = this.conjure.worms().find((p) => p.user.sessionId === sessionId)
		if (peer?.cursor) return peer.cursor
		const r = this.conjure.records.get().find((x) => x.sessionId === sessionId)
		return r ? { x: r.x, y: r.y } : null
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

	/** A highlight step's exact spot (point / region on an item, or "at" on anything else), if it has one and its target is here. */
	focusOf(step: AttentionAction | null | undefined): Focus | undefined {
		if (step?.kind !== 'highlight' || !step.target) return undefined
		const { kind, id } = parseSelectionId(step.target)
		if (kind === 'item' && (step.point || step.region)) {
			const box = this.editor.layout.get().items.get(id)
			const item = this.editor.items.get()[id]
			if (!box || !item?.width || !item.height) return undefined
			const sx = box.w / item.width
			const sy = box.h / item.height
			if (step.point) return { kind: 'point', box: { x: box.x + step.point.x * sx, y: box.y + step.point.y * sy, w: 0, h: 0 }, within: box }
			const r = step.region!
			return { kind: 'region', box: { x: box.x + r.x * sx, y: box.y + r.y * sy, w: r.w * sx, h: r.h * sy }, within: box }
		}
		if (kind !== 'item' && step.at) {
			const within = this.targetBox(step.target)
			return within && { kind: 'point', box: { x: step.at.x, y: step.at.y, w: 0, h: 0 }, within }
		}
		return undefined
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
		this.editor.revealKey(step.target)
		const focus = this.focusOf(step)
		if (focus) {
			this.stepZoom = this.revealFocus(focus)
			return true
		}
		const box = this.targetBox(step.target)
		if (!box) return false
		this.reveal(box, REVEAL_PAD)
		this.stepZoom = this.editor.camera.peek().z
		return true
	}

	/**
	 * Glides the camera so an exact spot is comfortably in view: centred if it's off screen or near
	 * the edge, zoomed in only as needed (a region to at least REGION_MIN_PX, an item pointed into to
	 * POINT_CONTEXT_PX, never past the focus caps), and out only if a region wouldn't fit in
	 * REGION_MAX_SHARE of the screen. Returns the zoom it settles at.
	 */
	revealFocus(focus: Focus): number {
		const editor = this.editor
		const cam = editor.camera.peek()
		const { w, h } = editor.viewport.peek()
		const p = Math.min(REVEAL_PAD, w / 6, h / 6)
		const top = Math.min(Math.max(p, TOP_INSET), h / 4)
		const roomW = w - p * 2
		const roomH = h - p - top
		const { box, within } = focus
		const cap = Math.min(FOCUS_MAX_ZOOM, within ? FOCUS_MAX_WIDTH / within.w : FOCUS_MAX_ZOOM)
		let z = cam.z
		const grow = (need: number) => {
			if (need > z) z = Math.max(z, Math.min(need, cap))
		}
		if (focus.kind === 'region') {
			grow(REGION_MIN_PX / Math.max(box.w, box.h))
			z = Math.min(z, REGION_MAX_SHARE * Math.min(roomW / box.w, roomH / box.h))
		} else if (within) grow(POINT_CONTEXT_PX / Math.max(within.w, within.h))
		const centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 }
		const s = editor.pageToScreen(box)
		const m = Math.max(p, Math.min(w, h) * EDGE_SHARE)
		const comfy = s.x >= m && s.y >= top && s.x + box.w * z <= w - m && s.y + box.h * z <= h - m
		if (z === cam.z && comfy) return z
		editor.stopCameraMotion()
		editor.setCamera({ x: w / 2 / z - centre.x, y: (top + roomH / 2) / z - centre.y, z }, { animate: true, duration: FOCUS_GLIDE_MS })
		return z
	}

	/** Slides the camera to bring the creature (and room for its walkthrough beside it) into view. */
	revealCreature(sessionId: string) {
		const at = this.creatureAt(sessionId)
		if (!at) return
		const z = this.editor.camera.peek().z
		const v = CREATURE_VIEW
		this.reveal({ x: at.x - v.left / z, y: at.y - v.top / z, w: (v.left + v.right) / z, h: (v.top + v.bottom) / z }, 24)
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
