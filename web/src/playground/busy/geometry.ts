/** Deterministic randomness (mulberry32). */
export function rng(seed: number) {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/** Integer hash of up to three ints, in [0, 1). */
export function hash3(x: number, y: number, z: number) {
	let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1274126177)
	h = Math.imul(h ^ (h >>> 13), 1274126177)
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const smooth = (t: number) => t * t * (3 - 2 * t)

/** 3D value noise in [0, 1]. */
export function noise3(x: number, y: number, z: number) {
	const ix = Math.floor(x)
	const iy = Math.floor(y)
	const iz = Math.floor(z)
	const fx = smooth(x - ix)
	const fy = smooth(y - iy)
	const fz = smooth(z - iz)
	const l = (a: number, b: number, t: number) => a + (b - a) * t
	const c = (dx: number, dy: number, dz: number) => hash3(ix + dx, iy + dy, iz + dz)
	return l(l(l(c(0, 0, 0), c(1, 0, 0), fx), l(c(0, 1, 0), c(1, 1, 0), fx), fy), l(l(c(0, 0, 1), c(1, 0, 1), fx), l(c(0, 1, 1), c(1, 1, 1), fx), fy), fz)
}
