// The Reference Manual's session badge colours (--rm-badge-1…8 in web/src/ui/theme.css): teal, orange,
// green, ochre, walnut, plot, slate, brick.
const COLORS = ['#2f8c96', '#d9744e', '#2b6a54', '#b88a2c', '#826465', '#7f8cc4', '#4a5560', '#8e3b2e']

/** A session's colour: its busy band, prompt and badges, and its dot in lists. */
export function sessionColor(sessionId: string) {
	let h = 0
	for (const ch of sessionId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
	return COLORS[h % COLORS.length]
}
