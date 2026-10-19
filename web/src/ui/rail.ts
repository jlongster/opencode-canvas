import type { LiveStatus, RailState } from '../multiplayer/Conjure'
import './rails.css'

/** How much of the rail shows: everything; glyph, state and counts (zoomed out); glyph and counts (far out). */
export type RailLevel = 'full' | 'compact' | 'min'

/** The glyph's kind per state (see .rg-* in rails.css). */
export const RAIL_KIND: Record<RailState, string> = {
	idle: 'idle',
	thinking: 'work',
	replying: 'work',
	waiting: 'wait',
	error: 'err',
	asleep: 'sleep',
}

const WORD: Record<RailState, string> = {
	idle: 'ready',
	thinking: 'thinking',
	replying: 'replying',
	waiting: 'needs you',
	error: 'error',
	asleep: 'asleep',
}

/** at most this many subagent pips; the count says how many there are */
const PIPS_MAX = 8

export function railWord(s: LiveStatus): string {
	if (s.state === 'error' && s.error === 'interrupted') return 'interrupted'
	if (s.state === 'idle' && !s.conjured) return s.muted ? 'muted' : 'ready'
	return WORD[s.state]
}

export const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** m:ss (or h:mm:ss) */
export function formatElapsed(ms: number) {
	const s = Math.max(0, Math.floor(ms / 1000))
	const h = Math.floor(s / 3600)
	const m = Math.floor((s % 3600) / 60)
	const ss = String(s % 60).padStart(2, '0')
	return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function ago(at: number) {
	const s = Math.max(0, (Date.now() - at) / 1000)
	if (s < 45) return 'just now'
	if (s < 3600) return `${Math.round(s / 60)}m ago`
	if (s < 86400) return `${Math.round(s / 3600)}h ago`
	return `${Math.round(s / 86400)}d ago`
}

/** Markdown as one plain line: links and images as their text, no markup characters. */
export function plainLine(text: string) {
	return text
		.replace(/```[\s\S]*?(```|$)/g, ' ')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[`*_~#>|]+/g, '')
		.replace(/\s+/g, ' ')
		.trim()
}

/** The reply's latest line, for the rail while it streams in. */
export function replyLine(reply: string | null) {
	if (!reply) return ''
	const lines = reply.split('\n').map(plainLine).filter(Boolean)
	return lines[lines.length - 1] ?? ''
}

/** Updates every running clock under root (spans with data-since) to now. */
export function tickElapsed(root: ParentNode, now = Date.now()) {
	for (const el of root.querySelectorAll<HTMLElement>('[data-since]')) {
		const text = formatElapsed(now - Number(el.dataset.since))
		if (el.textContent !== text) el.textContent = text
	}
}

export function glyph(kind: string, extra = '') {
	return `<i class="rg rg-${kind}${extra ? ` ${extra}` : ''}" aria-hidden="true"></i>`
}

/**
 * The inside of a frame's status rail, as HTML: glyph, state word, elapsed time while working, the
 * step in progress (or the reply line while replying), subagent pips and count, and the queued
 * attention count (a button: data-calls). `title` (pinned rails) shows the frame's title after the
 * state; `queuedText` previews the first queued step.
 */
export function railHtml(s: LiveStatus, o: { level: RailLevel; title?: string; queuedText?: string; narrow?: boolean }): string {
	const kind = RAIL_KIND[s.state]
	let html = glyph(kind)
	if (o.level !== 'min') {
		html += `<span class="rw">${escapeHtml(railWord(s))}</span>`
		if (s.busy && s.since) html += `<span class="rtm" data-since="${s.since}">${formatElapsed(Date.now() - s.since)}</span>`
	}
	if (o.title) html += `<span class="rt"><i class="rsep"></i><span class="rtt">${escapeHtml(o.title)}</span></span>`
	if (o.level === 'full' && !o.narrow) {
		const act = activity(s, o.queuedText)
		if (act) html += `<span class="ract${act.prose ? ' prose' : ''}${act.dim ? ' dim' : ''}${act.caret ? ' caret' : ''}">${escapeHtml(act.text)}</span>`
	}
	html += '<span class="rsp"></span>'
	if (s.running) {
		if (o.level !== 'min') {
			const pips = s.subagents.slice(0, PIPS_MAX)
			html += `<span class="rpips" aria-hidden="true">${pips.map((p, i) => `<i class="${p.done ? 'd' : ''}" style="animation-delay:${-i * 0.17}s"></i>`).join('')}</span>`
		}
		html += `<span class="rpn" title="${s.running} subagent${s.running === 1 ? '' : 's'} running">${s.running}</span>`
	}
	if (s.queued) {
		const label = o.level === 'full' && !o.narrow ? `${s.queued} queued` : String(s.queued)
		const title = `${s.queued} thing${s.queued === 1 ? '' : 's'} to show you${s.muted ? ' (muted)' : ''}: click to go through ${s.queued === 1 ? 'it' : 'them'}`
		html += `<button class="rpq${s.muted ? ' muted' : ''}" data-calls title="${escapeHtml(title)}">${label}</button>`
	}
	return html
}

function activity(s: LiveStatus, queuedText?: string): { text: string; prose?: boolean; dim?: boolean; caret?: boolean } | null {
	switch (s.state) {
		case 'thinking':
			return { text: s.activity && s.activity !== 'thinking' ? s.activity : 'thinking…', prose: !s.activity || s.activity === 'thinking' }
		case 'replying':
			return { text: replyLine(s.reply), prose: true, caret: true }
		case 'waiting':
			return { text: queuedText || 'wants to show you something', prose: true }
		case 'error':
			return s.error === 'interrupted' ? { text: s.endedAt ? `stopped ${ago(s.endedAt)}` : 'stopped', prose: true, dim: true } : { text: s.error ?? '' }
		case 'asleep':
			return { text: 'owner not connected', prose: true }
		case 'idle':
			if (!s.conjured) return s.queued ? { text: `${s.queued} muted`, prose: true, dim: true } : null
			if (!s.endedAt) return { text: s.ours ? 'press C to prompt it' : 'idle', prose: true, dim: true }
			return s.activity && s.activity !== 'thinking'
				? { text: `last: ${s.activity} · ${ago(s.endedAt)}`, dim: true }
				: { text: `last reply ${ago(s.endedAt)}`, prose: true, dim: true }
	}
}
