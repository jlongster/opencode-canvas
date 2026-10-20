import type { Editor } from '../editor/Editor'
import { react } from '../state/signals'
import { renameSession } from '../sync/client'
import { pairings } from './pairings'
import { listServerSessions, onSessionsListed } from './sessions'

const DEBOUNCE_MS = 500

/**
 * Keeps frames named after their OpenCode sessions, for edit links with a paired OpenCode: on load
 * (and on pairing) and whenever the paired servers' sessions are listed, a frame whose session one of them lists
 * under another title is renamed to it (at most once per session per load).
 */
export class FrameTitles {
	/** the latest title of every session the paired servers listed, by session id */
	private titles = new Map<string, string>()
	private renamed = new Set<string>()
	/** the servers asked for their sessions since load */
	private listed = new Set<string>()
	private timer = 0
	private disposers: (() => void)[] = []

	constructor(
		private editor: Editor,
		private canvasId: string,
	) {
		this.disposers.push(
			onSessionsListed((_key, sessions) => {
				for (const s of sessions) if (s.title) this.titles.set(s.id, s.title)
				this.schedule()
			}),
			react(() => {
				editor.sessions.get()
				this.schedule()
			}),
			react(() => {
				for (const p of pairings.get()) {
					if (this.listed.has(p.key)) continue
					this.listed.add(p.key)
					listServerSessions(p.key).catch(() => {})
				}
			}),
		)
	}

	destroy() {
		clearTimeout(this.timer)
		for (const d of this.disposers.splice(0)) d()
	}

	private schedule() {
		clearTimeout(this.timer)
		this.timer = window.setTimeout(() => this.apply(), DEBOUNCE_MS)
	}

	private apply() {
		for (const session of Object.values(this.editor.sessions.peek())) {
			const title = this.titles.get(session.id)
			if (!title || title === session.title || this.renamed.has(session.id)) continue
			this.renamed.add(session.id)
			renameSession(this.canvasId, session.id, title).catch(() => {})
		}
	}
}
