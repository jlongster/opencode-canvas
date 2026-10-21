import './shared/font'
import './shared/ui.css'
import './index.css'
import { el } from './shared/controls'
import { SITES } from './shared/shell'

const NOTES: Record<string, string> = {
	busy: 'The session is working: six treatments of the frame’s edge, rendered as light.',
	subagents: 'Subagents are running: six small typographic indicators beside the frame title.',
}

const list = el('nav', 'ix-list')
for (const s of SITES) {
	const a = el('a', 'ix-card', el('span', 'ix-name', s.name), el('span', 'ix-note', NOTES[s.id]), el('span', 'ix-go', '→'))
	a.href = s.href
	list.append(a)
}
document.title = 'Frame status playground'
document.body.append(el('main', 'ix', el('h1', '', 'Frame status playground'), el('p', 'ix-sub', 'Two separate problems, one site each.'), list))
