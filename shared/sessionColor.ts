const COLORS = ['#f472b6', '#a78bfa', '#fb923c', '#4ade80', '#facc15', '#f87171', '#60a5fa', '#2dd4bf', '#e879f9', '#a3e635']

/** A session's colour: its busy band, prompt and badges, and its dot in lists. */
export function sessionColor(sessionId: string) {
	let h = 0
	for (const ch of sessionId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
	return COLORS[h % COLORS.length]
}
