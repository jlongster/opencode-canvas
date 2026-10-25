/**
 * The Reference Manual's paper and ink, for what's drawn outside CSS (the WebGPU canvas, link cards).
 * The same values as the custom properties in ui/theme.css: keep the two in step.
 */
export const THEME = {
	/** the canvas, behind everything (--rm-ground) */
	canvas: '#eceae3',
	/** a session's frame (--rm-sheet) */
	frame: '#fbfaf6',
	/** toolbars, popovers (--rm-sheet) */
	panel: '#fbfaf6',
	/** things on a panel */
	raised: '#f2f0ea',
	/** type, rules, selection (--rm-ink) */
	ink: '#151515',
	/** secondary text (--rm-ink-2) */
	ink2: '#4f4d48',
	/** muted labels (--rm-ink-3) */
	ink3: '#8a877f',
	/** hairlines (--rm-rule) */
	rule: '#d5d1c6',
	/** stronger hairlines (--rm-rule-2) */
	rule2: '#b9b4a8',
	/** waiting on you, the red pencil (--rm-red) */
	red: '#c2381f',
	/** running (--rm-blue) */
	blue: '#1e5c88',
	/** the person-added tag (--rm-buff) */
	buff: '#e8d9c1',
	/** session badges (--rm-badge-1 … 8): teal, orange, green, ochre, walnut, plot, slate, brick */
	badges: ['#2f8c96', '#d9744e', '#2b6a54', '#b88a2c', '#826465', '#7f8cc4', '#4a5560', '#8e3b2e'],
} as const
