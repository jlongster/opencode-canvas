/**
 * Where a card is and how it's turned: every number interpolates, so any two states blend.
 * (x, y) is the page position of the top-centre of the card's box; the box is bw × bh in the card's
 * own units, drawn at scale s. Rotations are about a horizontal hinge at hy (0 top … 1 bottom of the
 * box), then the whole family's lean (grx about gx, gy), all seen through a perspective of `persp`
 * page units from (pox, poy). rz is a flat, in-plane turn about the same hinge point (a fanned hand).
 */
export interface Pose {
	x: number
	y: number
	s: number
	bw: number
	bh: number
	hy: number
	rx: number
	ry: number
	/** in-plane rotation (deg), about the box's centre line at the hinge: stays a 2D transform */
	rz: number
	tz: number
	gx: number
	gy: number
	grx: number
	pox: number
	poy: number
	persp: number
	/** opacity */
	o: number
	/** 0…1 darkening (deeper in a stack) */
	shade: number
	/** how present the deck strip (title on the peeking edge) is */
	strip: number
	/** drop shadow strength */
	sh: number
	/** how present the index tab (zoomed-out "tabs" layout) is */
	tab: number
}

export const pose = (o: Partial<Pose> = {}): Pose => ({
	x: 0,
	y: 0,
	s: 1,
	bw: 100,
	bh: 100,
	hy: 0,
	rx: 0,
	ry: 0,
	rz: 0,
	tz: 0,
	gx: 0,
	gy: 0,
	grx: 0,
	pox: 0,
	poy: 0,
	persp: 2400,
	o: 1,
	shade: 0,
	strip: 0,
	sh: 0,
	tab: 0,
	...o,
})

const KEYS = Object.keys(pose()) as (keyof Pose)[]

export function lerpPose(a: Pose, b: Pose, t: number, out: Pose = pose()): Pose {
	if (t <= 0) return Object.assign(out, a)
	if (t >= 1) return Object.assign(out, b)
	for (const k of KEYS) out[k] = a[k] + (b[k] - a[k]) * t
	return out
}

export const copyPose = (p: Pose): Pose => ({ ...p })

const n = (v: number) => (Math.abs(v) < 1e-4 ? '0' : v.toFixed(2))
const sc = (v: number) => v.toFixed(5)

/** The CSS transform (origin 0 0) that draws a card at this pose in page space. Flat poses get a 2D transform, so text stays crisp. */
export function transformOf(p: Pose): string {
	const w = p.bw * p.s
	const flat = Math.abs(p.rx) < 0.01 && Math.abs(p.ry) < 0.01 && Math.abs(p.tz) < 0.05 && Math.abs(p.grx) < 0.01
	const hy = p.hy * p.bh * p.s
	if (flat) {
		if (Math.abs(p.rz) < 0.01) return `translate(${n(p.x - w / 2)}px,${n(p.y)}px) scale(${sc(p.s)})`
		return `translate(${n(p.x)}px,${n(p.y + hy)}px) rotate(${n(p.rz)}deg) translate(${n(-w / 2)}px,${n(-hy)}px) scale(${sc(p.s)})`
	}
	let t = `translate(${n(p.pox)}px,${n(p.poy)}px) perspective(${n(p.persp)}px) translate(${n(-p.pox)}px,${n(-p.poy)}px)`
	if (Math.abs(p.grx) >= 0.01) t += ` translate(${n(p.gx)}px,${n(p.gy)}px) rotateX(${n(p.grx)}deg) translate(${n(-p.gx)}px,${n(-p.gy)}px)`
	t += ` translate3d(${n(p.x)}px,${n(p.y + hy)}px,${n(p.tz)}px)`
	if (Math.abs(p.rx) >= 0.01) t += ` rotateX(${n(p.rx)}deg)`
	if (Math.abs(p.ry) >= 0.01) t += ` rotateY(${n(p.ry)}deg)`
	if (Math.abs(p.rz) >= 0.01) t += ` rotate(${n(p.rz)}deg)`
	t += ` translate(${n(-w / 2)}px,${n(-hy)}px) scale(${sc(p.s)})`
	return t
}

/** Pushes a pose back toward (cx, cy) by k (< 1), as if further away. */
export function recede(p: Pose, cx: number, cy: number, k: number) {
	if (k === 1) return
	p.x = cx + (p.x - cx) * k
	p.y = cy + (p.y - cy) * k
	p.gx = cx + (p.gx - cx) * k
	p.gy = cy + (p.gy - cy) * k
	p.pox = cx + (p.pox - cx) * k
	p.poy = cy + (p.poy - cy) * k
	p.s *= k
	p.tz *= k
	p.persp *= k
}
