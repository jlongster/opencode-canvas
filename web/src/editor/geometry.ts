export interface Vec {
	x: number
	y: number
}

export interface Box {
	x: number
	y: number
	w: number
	h: number
}

export const Vec = {
	sub: (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y }),
	add: (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y }),
	dist: (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y),
	equals: (a: Vec, b: Vec) => a.x === b.x && a.y === b.y,
}

export const Box = {
	fromPoints(a: Vec, b: Vec): Box {
		const x = Math.min(a.x, b.x)
		const y = Math.min(a.y, b.y)
		return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
	},
	contains: (b: Box, p: Vec) => p.x >= b.x && p.y >= b.y && p.x <= b.x + b.w && p.y <= b.y + b.h,
	intersects: (a: Box, b: Box) =>
		a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y,
	expand: (b: Box, n: number): Box => ({ x: b.x - n, y: b.y - n, w: b.w + n * 2, h: b.h + n * 2 }),
	union(boxes: Iterable<Box>): Box | null {
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
		for (const b of boxes) {
			minX = Math.min(minX, b.x)
			minY = Math.min(minY, b.y)
			maxX = Math.max(maxX, b.x + b.w)
			maxY = Math.max(maxY, b.y + b.h)
		}
		return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
	},
	equals: (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h,
}

export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
