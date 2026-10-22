import type { NoteAnchor } from '../../../shared/types'
import { Box, type Vec } from '../editor/geometry'
import { frameTitleBox, type Layout, type SectionLayout } from '../editor/layout'
import { parseSelectionId } from '../editor/selection'

/** Page-space size of a person's note; agents' notes are as wide, and grow with their text up to AGENT_NOTE_MAX_H. */
export const NOTE_W = 220
export const NOTE_H = 180
export const AGENT_NOTE_MAX_H = 340
/** between notes stacked at the top of a frame, and between the bottom row and the frame (page px) */
const STACK_GAP = 20
/** between a note and a whole target it's placed beside */
const BESIDE_GAP = 24
/** how far a note stands off an exact point or region, nearest first (its pointer spans the gap) */
const SPOT_DISTANCES = [80, 150, 240]
/** room kept clear round an exact point or region, so the note never covers it or what's right by it */
const POINT_CLEAR = 60
const REGION_CLEAR = 16

/** An agent's note to place (see NoteAnchor). */
export interface AgentNoteInput extends NoteAnchor {
	id: string
	sessionId: string
	createdAt: number
	/** its height (page px): agents' notes grow with their text */
	h: number
	/** where it was put (page): used only when nothing it's anchored to is on the canvas */
	x: number
	y: number
	/** dragged by someone: its offset from its anchor's reference corner (see NotePlacement.ref) */
	moved?: Vec
}

/** What a placed note points at on the page: an exact point or region (drawn with a pointer), or the whole target it's beside. */
export interface NoteSpot {
	kind: 'point' | 'region' | 'target'
	box: Box
}

export interface NotePlacement {
	box: Box
	/** null for a note at the top of its frame (or loose) */
	spot: NoteSpot | null
	/** what a drag is measured from: the spot's corner, the target's, or the frame's */
	ref: Vec
	/** a note at the top of its frame: the frame's title row under it, to show with it */
	frameTitle?: Box
}

export interface PlacementWorld {
	layout: Layout
	z: number
	/** the page box of a target (selection key) laid out on the canvas, except notes (see notes) */
	targetBox(key: string): Box | undefined
	/** an item's laid-out box and its original pixel size, for points and regions */
	itemPixels(id: string): { box: Box; width: number; height: number } | undefined
	/** people's notes' page boxes: agents' notes target them, and try not to cover them */
	notes: Map<string, Box>
	/** whether the session has a frame on the canvas (hidden or not) */
	hasFrame(sessionId: string): boolean
}

type Resolved =
	| { kind: 'frame'; section: SectionLayout }
	| { kind: 'beside'; spot: NoteSpot; within: Box }
	/** a highlight of a note: resolved while placing, as the note may be an agent's placed just before */
	| { kind: 'note'; noteId: string; at?: Vec }
	| { kind: 'loose' }
	| { kind: 'hidden' }

/**
 * Where agents' notes go (missing from the result: hidden, as what they're anchored to is in a
 * hidden frame).
 *
 * - A say, a highlight of a frame without "at", or a note whose target is gone: at the top of its
 *   frame, above the title, stacked in rows from the frame's left edge, oldest first and nearest
 *   the frame, so none overlaps another or the title (which grows upward when zoomed far out).
 * - A highlight: right next to its target, never over the spot it points at (an exact point or
 *   region, or the whole target), keeping off the other agents' notes, frame titles and people's
 *   notes as far as it can, as close to the spot as it can.
 * - A note someone dragged stays where they put it, relative to what it's anchored to.
 */
export function placeAgentNotes(notes: AgentNoteInput[], world: PlacementWorld): Map<string, NotePlacement> {
	const out = new Map<string, NotePlacement>()
	const sorted = [...notes].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
	const agentIds = new Set(sorted.map((n) => n.id))
	const resolved = new Map(sorted.map((n) => [n.id, resolve(n, world, agentIds)]))

	// The stacks at the tops of frames first, so the notes placed beside things keep off them.
	const stacks = new Map<SectionLayout, AgentNoteInput[]>()
	for (const n of sorted) {
		const r = resolved.get(n.id)!
		if (r.kind === 'loose') out.set(n.id, { box: { x: n.x, y: n.y, w: NOTE_W, h: n.h }, spot: null, ref: { x: n.x, y: n.y } })
		if (r.kind !== 'frame') continue
		const ref = { x: r.section.box.x, y: r.section.box.y }
		if (n.moved) out.set(n.id, { box: { x: ref.x + n.moved.x, y: ref.y + n.moved.y, w: NOTE_W, h: n.h }, spot: null, ref, frameTitle: titleRow(r.section) })
		else stacks.set(r.section, [...(stacks.get(r.section) ?? []), n])
	}
	for (const [section, list] of stacks) {
		const ref = { x: section.box.x, y: section.box.y }
		const frameTitle = titleRow(section)
		const cols = Math.max(1, Math.floor((section.box.w + STACK_GAP) / (NOTE_W + STACK_GAP)))
		let bottom = Math.min(section.box.y, frameTitleBox(section, world.z).y) - STACK_GAP
		for (let i = 0; i < list.length; i += cols) {
			const row = list.slice(i, i + cols)
			row.forEach((n, c) => out.set(n.id, { box: { x: section.box.x + c * (NOTE_W + STACK_GAP), y: bottom - n.h, w: NOTE_W, h: n.h }, spot: null, ref, frameTitle }))
			bottom -= Math.max(...row.map((n) => n.h)) + STACK_GAP
		}
	}

	// What notes placed beside things keep off: frame titles (as drawn at full size), people's notes and items.
	const titles = world.layout.sections.map((s) => frameTitleBox(s, 1))
	const people = [...world.notes.values()]
	const items = [...world.layout.items.values()]
	for (const n of sorted) {
		let r = resolved.get(n.id)!
		if (r.kind === 'note') {
			const box = world.notes.get(r.noteId) ?? out.get(r.noteId)?.box
			r = box ? { kind: 'beside', within: box, spot: r.at ? pointSpot(r.at) : { kind: 'target', box } } : { kind: 'loose' }
			if (r.kind === 'loose') out.set(n.id, { box: { x: n.x, y: n.y, w: NOTE_W, h: n.h }, spot: null, ref: { x: n.x, y: n.y } })
		}
		if (r.kind !== 'beside') continue
		const { spot } = r
		const ref = { x: spot.box.x, y: spot.box.y }
		if (n.moved) {
			out.set(n.id, { box: { x: ref.x + n.moved.x, y: ref.y + n.moved.y, w: NOTE_W, h: n.h }, spot, ref })
			continue
		}
		// Other notes, and the exact spots other notes point at.
		const taken = [...out.values()].flatMap((p) => (p.spot && p.spot.kind !== 'target' ? [p.box, clearing(p.spot)] : [p.box]))
		const reach = Box.expand(spot.box, Math.max(...SPOT_DISTANCES) + NOTE_W + AGENT_NOTE_MAX_H)
		const near = items.filter((b) => Box.intersects(b, reach))
		out.set(n.id, { box: beside(spot, n.h, { taken, titles, people, items: near }), spot, ref })
	}
	return out
}

/** What a note is anchored to, as the canvas is now. */
function resolve(n: AgentNoteInput, world: PlacementWorld, agentIds: Set<string>): Resolved {
	const { layout } = world
	const atFrame = (sessionId: string): Resolved | null => {
		const section = layout.sections.find((s) => s.id === sessionId)
		return section ? { kind: 'frame', section } : null
	}
	const fallback = (): Resolved => atFrame(n.sessionId) ?? (world.hasFrame(n.sessionId) ? { kind: 'hidden' } : { kind: 'loose' })
	if (n.kind !== 'highlight' || !n.target) return fallback()
	const { kind, id } = parseSelectionId(n.target)
	if (kind === 'note') return world.notes.has(id) || agentIds.has(id) ? { kind: 'note', noteId: id, at: n.at } : fallback()
	if (kind === 'frame' && !n.at) return atFrame(id) ?? fallback()
	if (kind === 'item' && (n.point || n.region)) {
		const px = world.itemPixels(id)
		if (!px) return fallback()
		const sx = px.box.w / px.width
		const sy = px.box.h / px.height
		const within = world.targetBox(id) ?? px.box
		if (n.point) return { kind: 'beside', within, spot: pointSpot({ x: px.box.x + n.point.x * sx, y: px.box.y + n.point.y * sy }) }
		const g = n.region!
		return { kind: 'beside', within, spot: { kind: 'region', box: { x: px.box.x + g.x * sx, y: px.box.y + g.y * sy, w: g.w * sx, h: g.h * sy } } }
	}
	const box = world.targetBox(n.target)
	if (!box) return fallback()
	if (n.at && kind !== 'item') return { kind: 'beside', within: box, spot: pointSpot(n.at) }
	return { kind: 'beside', within: box, spot: { kind: 'target', box } }
}

const pointSpot = (p: Vec): NoteSpot => ({ kind: 'point', box: { x: p.x, y: p.y, w: 0, h: 0 } })

/** What a note placed beside something keeps off, most important first. */
interface Obstacles {
	/** agents' notes already placed, and the spots they point at */
	taken: Box[]
	titles: Box[]
	people: Box[]
	/** items near the spot: covering one is only worth avoiding when it's not much further away */
	items: Box[]
}

/**
 * The best place for an h-tall note beside a spot: of the candidates round it (nearest first), the
 * one that never covers the spot (plus some room), overlaps the least of the notes already placed,
 * frame titles, people's notes and items, and stays closest.
 */
function beside(spot: NoteSpot, h: number, { taken, titles, people, items }: Obstacles): Box {
	const w = NOTE_W
	const s = spot.box
	const clear = clearing(spot)
	const candidates: { box: Box; penalty: number }[] = []
	const add = (x: number, y: number, penalty: number) => candidates.push({ box: { x, y, w, h }, penalty })
	if (spot.kind === 'target') {
		// Along each side of the target, sliding further along as nearer slots are taken.
		for (let k = 0; k < 4; k++) {
			add(s.x + s.w + BESIDE_GAP, s.y + k * (h + BESIDE_GAP), k * 40)
			add(s.x - BESIDE_GAP - w, s.y + k * (h + BESIDE_GAP), 15 + k * 40)
			add(s.x + k * (w + BESIDE_GAP), s.y - BESIDE_GAP - h, 30 + k * 40)
			add(s.x + k * (w + BESIDE_GAP), s.y + s.h + BESIDE_GAP, 35 + k * 40)
		}
	} else {
		const cx = s.x + s.w / 2
		const cy = s.y + s.h / 2
		SPOT_DISTANCES.forEach((d, i) => {
			const far = i * 60
			const diag = d * 0.7
			add(s.x + s.w + d, cy - h * 0.3, far)
			add(s.x - d - w, cy - h * 0.3, far + 8)
			add(s.x + s.w + diag, s.y + s.h + diag, far + 12)
			add(s.x + s.w + diag, s.y - diag - h, far + 14)
			add(cx - w * 0.3, s.y + s.h + d, far + 16)
			add(cx - w * 0.3, s.y - d - h, far + 18)
			add(s.x - diag - w, s.y + s.h + diag, far + 20)
			add(s.x - diag - w, s.y - diag - h, far + 22)
		})
	}
	let best = candidates[0]!.box
	let bestCost = Infinity
	for (const { box, penalty } of candidates) {
		let cost = penalty + gap(box, s)
		if (overlap(box, clear) > 0) cost += 1e9
		for (const t of taken) cost += overlap(box, t) * 50
		for (const t of titles) cost += overlap(box, t) * 20
		for (const p of people) cost += overlap(box, p) * 5
		// covering a whole item costs about as much as standing 150px further off
		for (const i of items) cost += overlap(box, i) * 0.004
		if (cost < bestCost) {
			best = box
			bestCost = cost
		}
	}
	return best
}

/** A frame's title row (its header strip, from the frame's top), shown with notes stacked above it. */
const titleRow = (s: SectionLayout): Box => ({ x: s.box.x, y: s.box.y, w: s.box.w, h: s.header.y + s.header.h - s.box.y })

/** The spot with the room kept clear round it. */
const clearing = (spot: NoteSpot) => Box.expand(spot.box, spot.kind === 'point' ? POINT_CLEAR : spot.kind === 'region' ? REGION_CLEAR : 0)

/** The area two boxes share. */
function overlap(a: Box, b: Box) {
	const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
	const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
	return w > 0 && h > 0 ? w * h : 0
}

/** The distance between two boxes (0 when they touch or overlap). */
function gap(a: Box, b: Box) {
	const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w))
	const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h))
	return Math.hypot(dx, dy)
}

/**
 * A note's pointer: from the edge of the note toward its spot, ending on the point (or on the
 * region's edge nearest the note). Null when they overlap.
 */
export function pointerLine(note: Box, spot: NoteSpot): { from: Vec; to: Vec } | null {
	const c = { x: note.x + note.w / 2, y: note.y + note.h / 2 }
	const s = spot.box
	const to = { x: clampTo(c.x, s.x, s.x + s.w), y: clampTo(c.y, s.y, s.y + s.h) }
	if (Box.contains(note, to)) return null
	const from = { x: clampTo(to.x, note.x, note.x + note.w), y: clampTo(to.y, note.y, note.y + note.h) }
	return { from, to }
}

const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
