import { createRoot } from 'react-dom/client'
import { App } from './ui/App'
import { CanvasList } from './ui/CanvasList'
import { NotFound } from './ui/NotFound'
import { PairNotice, readPairFragment } from './ui/PairNotice'
import type { CanvasLink } from './sync/client'
import { APP_PATH } from './base'
import './ui/styles.css'

/** "/" is the canvas list; /c/:id opens a canvas to edit, /v/:viewKey opens it view-only. */
function route(): CanvasLink | 'list' | null {
	if (APP_PATH === '/') return 'list'
	const id = /^\/c\/([A-Za-z0-9]{10})\/?$/.exec(APP_PATH)?.[1]
	if (id) return { role: 'edit', id }
	const viewKey = /^\/v\/([A-Za-z0-9]{16})\/?$/.exec(APP_PATH)?.[1]
	return viewKey ? { role: 'view', viewKey } : null
}

// `bunx opencode-canvas` (or a handoff link) opens the page with a one-time pairing code in the
// fragment: take it out of the URL before anything else reads the hash, and offer it.
readPairFragment()

const page = route()

createRoot(document.getElementById('root')!).render(
	<>
		{page === 'list' ? <CanvasList /> : page ? <App link={page} /> : <NotFound message="There's no page here." />}
		<PairNotice offers={page === 'list' || page?.role === 'edit'} />
	</>,
)
