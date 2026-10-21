/** A tweakable parameter of a variation, with its default value. */
export type ParamDef =
	| { key: string; label: string; type: 'range'; min: number; max: number; step: number; value: number; unit?: string }
	| { key: string; label: string; type: 'color'; value: string }
	| { key: string; label: string; type: 'toggle'; value: boolean }
	| { key: string; label: string; type: 'select'; options: string[]; value: string }

export type ParamValue = number | string | boolean
export type ParamValues = Record<string, ParamValue>

export const range = (key: string, label: string, value: number, min: number, max: number, step: number, unit?: string): ParamDef => ({
	key,
	label,
	type: 'range',
	value,
	min,
	max,
	step,
	unit,
})
export const toggle = (key: string, label: string, value: boolean): ParamDef => ({ key, label, type: 'toggle', value })
export const color = (key: string, label: string, value: string): ParamDef => ({ key, label, type: 'color', value })
export const select = (key: string, label: string, options: string[], value: string): ParamDef => ({ key, label, type: 'select', options, value })

/** Every variation starts with a speed multiplier; time is accumulated with it, so changing it never jumps. */
export const SPEED = range('speed', 'Speed', 1, 0, 3, 0.05, '×')

export function defaults(defs: ParamDef[]): ParamValues {
	return Object.fromEntries(defs.map((d) => [d.key, d.value]))
}

/** The values for defs, taking what's valid from saved and defaults for the rest. */
export function resolve(defs: ParamDef[], saved: ParamValues | undefined): ParamValues {
	const out: ParamValues = {}
	for (const d of defs) {
		const v = saved?.[d.key]
		if (d.type === 'range') out[d.key] = typeof v === 'number' && isFinite(v) ? Math.min(d.max, Math.max(d.min, v)) : d.value
		else if (d.type === 'toggle') out[d.key] = typeof v === 'boolean' ? v : d.value
		else if (d.type === 'color') out[d.key] = typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : d.value
		else out[d.key] = typeof v === 'string' && d.options.includes(v) ? v : d.value
	}
	return out
}

/** Only the values that differ from the defaults (what the URL hash carries). */
export function changed(defs: ParamDef[], values: ParamValues): ParamValues {
	const out: ParamValues = {}
	for (const d of defs) if (values[d.key] !== d.value) out[d.key] = values[d.key]
	return out
}

export function hexToRgb(hex: string): [number, number, number] {
	const n = parseInt(hex.slice(1), 16)
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Uniform slots: a colour takes three floats, everything else one (toggles 0/1, selects their index). */
export function slotCount(d: ParamDef) {
	return d.type === 'color' ? 3 : 1
}

/** `#define P_key u_p[i]` for each param, so shader bodies can name them. */
export function glslDefines(defs: ParamDef[]): string {
	let i = 0
	const lines: string[] = []
	for (const d of defs) {
		if (d.type === 'color') lines.push(`#define P_${d.key} vec3(u_p[${i}], u_p[${i + 1}], u_p[${i + 2}])`)
		else lines.push(`#define P_${d.key} u_p[${i}]`)
		i += slotCount(d)
	}
	return lines.join('\n')
}

export function pack(defs: ParamDef[], values: ParamValues, out: Float32Array) {
	let i = 0
	for (const d of defs) {
		const v = values[d.key]
		if (d.type === 'color') out.set(hexToRgb(v as string), i)
		else if (d.type === 'toggle') out[i] = v ? 1 : 0
		else if (d.type === 'select') out[i] = Math.max(0, d.options.indexOf(v as string))
		else out[i] = v as number
		i += slotCount(d)
	}
}
