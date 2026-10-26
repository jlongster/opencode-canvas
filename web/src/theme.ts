/**
 * The Reference Manual's paper and ink, for what's drawn outside CSS (the WebGPU canvas, link cards).
 * The same values as the custom properties in ui/theme.css: keep the two in step.
 */
export const THEME = {
	/** the canvas, behind everything (--rm-ground) */
	canvas: '#e4e5e8',
	/** a session's frame (--rm-sheet) */
	frame: '#f9f9fa',
	/** toolbars, popovers (--rm-sheet) */
	panel: '#f9f9fa',
	/** things on a panel */
	raised: '#f0f1f3',
	/** type, rules, selection (--rm-ink) */
	ink: '#16181b',
	/** secondary text (--rm-ink-2) */
	ink2: '#4a4e55',
	/** muted labels (--rm-ink-3) */
	ink3: '#858990',
	/** hairlines (--rm-rule) */
	rule: '#d2d4d8',
	/** stronger hairlines (--rm-rule-2) */
	rule2: '#b3b6bc',
	/** waiting on you, the red pencil (--rm-red) */
	red: '#c4362a',
	/** running (--rm-blue) */
	blue: '#1f5d8c',
	/** the printout bar (--rm-bar) */
	bar: '#e9edf1',
	/** the plus-marks on the canvas, every module */
	plus: '#c3c6cc',
	/** queued placeholders' pinstripes (--rm-pinstripe) */
	pinstripe: '#b8bbc1',
	/** the person-added tag (--rm-buff) */
	buff: '#e5e1da',
	/** session badges (--rm-badge-1 … 8): teal, orange, green, ochre, walnut, plot, slate, brick */
	badges: ['#2f8c96', '#d9744e', '#2b6a54', '#b88a2c', '#826465', '#7f8cc4', '#4a5560', '#8e3b2e'],
} as const
