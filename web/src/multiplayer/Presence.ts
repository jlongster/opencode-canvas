import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import type { Camera, Editor } from '../editor/Editor'
import { clamp, type Box, type Vec } from '../editor/geometry'
import { atom, react } from '../state/signals'
import { url, wsUrl } from '../base'

export interface PeerUser {
	name: string
	color: string
	/** set by AI agents working through the canvas MCP server: no cursor or view, just activity */
	agent?: boolean
	/** a conjured worm: an OpenCode session brought onto the canvas, which edit links can prompt */
	conjured?: boolean
	/** conjured worms: their OpenCode session, and the (non-secret key of the) OpenCode it lives on */
	sessionId?: string
	serverKey?: string
	/** conjured worms nobody is running right now (drawn locally from their record, never broadcast) */
	asleep?: boolean
}

/** What each person broadcasts through Yjs awareness. */
export interface PresenceState {
	user: PeerUser
	/** page coordinates, or null when their pointer is off the canvas */
	cursor: Vec | null
	selection: string[]
	/** the part of the page they're looking at */
	view: Box | null
	/** cursor chat message, shown next to their cursor while it's set */
	chat: string | null
	/** true once the message was sent (Enter), so viewers can fade it out */
	chatSent: boolean
	/** agents: chat is something they say (a speech bubble) rather than an activity */
	speaking?: boolean
	/** conjured worms: their session is working on a prompt */
	thinking?: boolean
	/** conjured worms: their busy subagents (child sessions), oldest first */
	subagents?: SubagentInfo[]
}

export interface SubagentInfo {
	id: string
	title: string
	/** the agent it runs as, e.g. "general" */
	agent?: string
}

export interface Peer extends PresenceState {
	clientId: number
}

const USER_KEY = 'canvas.user'
const PUBLISH_MS = 40
const FOLLOW_EASE_MS = 70
const CHAT_LINGER_MS = 5000
const CHAT_MAX = 140

export const COLORS = ['#f87171', '#fb923c', '#facc15', '#4ade80', '#2dd4bf', '#38bdf8', '#818cf8', '#c084fc', '#f472b6', '#a3e635']
const ADJECTIVES = ['Curious', 'Brave', 'Quiet', 'Swift', 'Clever', 'Gentle', 'Lucky', 'Sunny', 'Bold', 'Calm', 'Witty', 'Cosmic']
const ANIMALS = ['Otter', 'Fox', 'Panda', 'Falcon', 'Badger', 'Heron', 'Lynx', 'Walrus', 'Koala', 'Raven', 'Tiger', 'Moth']

/**
 * Live presence for a room: who's here, their cursors, what they've selected and what they're
 * looking at. Built on Yjs awareness over the server's y-websocket endpoint.
 */
export class Presence {
	readonly peers = atom<Peer[]>('peers', [])
	readonly me = atom<PeerUser>('me', loadUser())
	readonly followingId = atom<number | null>('followingId', null)
	readonly status = atom<'connecting' | 'connected' | 'disconnected'>('presenceStatus', 'connecting')
	/** Our cursor chat message (null when there's none) and whether we're still typing it */
	readonly chat = atom<string | null>('chat', null)
	readonly chatOpen = atom<boolean>('chatOpen', false)
	private chatTimer = 0

	/** The canvas's document: notes (and later drawings). Read-only on view links. */
	readonly doc = new Y.Doc()
	private provider: WebsocketProvider
	private disposers: (() => void)[] = []
	private publishTimer = 0
	private applyingFollow = false

	constructor(
		private editor: Editor,
		room: string,
		/** view links join read-only */
		viewOnly = false,
	) {
		const params: Record<string, string> = viewOnly ? { view: '1' } : {}
		this.provider = new WebsocketProvider(wsUrl('/api/rooms'), room, this.doc, { disableBc: true, params })
		const awareness = this.provider.awareness

		this.provider.on('status', ({ status }: { status: string }) => {
			this.status.set(status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : 'disconnected')
		})
		const onChange = () => this.readPeers()
		awareness.on('change', onChange)
		this.disposers.push(() => awareness.off('change', onChange))

		// Publish our own state whenever any part of it changes (throttled).
		this.disposers.push(
			react(() => {
				this.me.get()
				this.chat.get()
				this.chatOpen.get()
				editor.pointerPage.get()
				editor.selectedIds.get()
				editor.viewportPageBounds.get()
				this.schedulePublish()
			}),
		)

		// If we move the camera ourselves while following, stop following.
		this.disposers.push(
			react(() => {
				editor.camera.get()
				if (!this.applyingFollow && this.followingId.peek() !== null) this.followingId.set(null)
			}),
		)

		// Stop following someone who left.
		this.disposers.push(
			react(() => {
				const id = this.followingId.get()
				if (id !== null && !this.peers.get().some((p) => p.clientId === id)) this.followingId.set(null)
			}),
		)

		this.disposers.push(editor.onFrame((_now, elapsed) => this.stepFollow(elapsed)))

		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && this.followingId.peek() !== null) this.followingId.set(null)
			const target = e.target as HTMLElement | null
			const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
			if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
				e.preventDefault()
				this.openChat()
			}
		}
		window.addEventListener('keydown', onKey)
		this.disposers.push(() => window.removeEventListener('keydown', onKey))

		this.publish()
		if (!localStorage.getItem(USER_KEY)) this.adoptExeIdentity()
	}

	setName(name: string) {
		const trimmed = name.trim().slice(0, 40)
		if (!trimmed) return
		this.setUser({ ...this.me.peek(), name: trimmed })
	}

	setColor(color: string) {
		this.setUser({ ...this.me.peek(), color })
	}

	// ---------- cursor chat ----------
	// "/" opens a bubble at your cursor. Others see the text live as you type. Enter keeps the
	// message up for a few seconds and then it fades; Escape removes it right away.

	openChat() {
		clearTimeout(this.chatTimer)
		this.chat.set('')
		this.chatOpen.set(true)
	}

	setChatText(text: string) {
		this.chat.set(text.slice(0, CHAT_MAX))
	}

	commitChat() {
		this.chatOpen.set(false)
		clearTimeout(this.chatTimer)
		if (!this.chat.peek()) return this.chat.set(null)
		this.chatTimer = window.setTimeout(() => this.chat.set(null), CHAT_LINGER_MS)
	}

	closeChat() {
		clearTimeout(this.chatTimer)
		this.chatOpen.set(false)
		this.chat.set(null)
	}

	toggleFollow(clientId: number) {
		this.followingId.set(this.followingId.peek() === clientId ? null : clientId)
	}

	get clientId() {
		return this.provider.awareness.clientID
	}

	destroy() {
		clearTimeout(this.publishTimer)
		clearTimeout(this.chatTimer)
		for (const d of this.disposers.splice(0)) d()
		this.provider.awareness.setLocalState(null)
		this.provider.destroy()
		this.doc.destroy()
	}

	private setUser(user: PeerUser) {
		this.me.set(user)
		localStorage.setItem(USER_KEY, JSON.stringify(user))
	}

	/** Visitors logged in to exe.dev get their email's name instead of a random one. */
	private async adoptExeIdentity() {
		let name = ''
		try {
			const { email } = (await (await fetch(url('/api/me'))).json()) as { email: string | null }
			name = (email ?? '')
				.split('@')[0]
				.split(/[._-]+/)
				.filter(Boolean)
				.map((part) => part[0].toUpperCase() + part.slice(1))
				.join(' ')
		} catch {
			// keep the random name
		}
		if (localStorage.getItem(USER_KEY)) return
		// Save either way, so a random identity stays the same across visits.
		this.setUser(name ? { ...this.me.peek(), name } : this.me.peek())
	}

	private schedulePublish() {
		if (this.publishTimer) return
		this.publishTimer = window.setTimeout(() => {
			this.publishTimer = 0
			this.publish()
		}, PUBLISH_MS)
	}

	private publish() {
		const { editor } = this
		const state: PresenceState = {
			user: this.me.peek(),
			cursor: editor.pointerPage.peek(),
			selection: editor.selectedIds.peek(),
			chat: this.chat.peek(),
			chatSent: !this.chatOpen.peek(),
			view: editor.viewportPageBounds.get(),
		}
		this.provider.awareness.setLocalState(state)
	}

	private readPeers() {
		const own = this.provider.awareness.clientID
		const peers: Peer[] = []
		for (const [clientId, state] of this.provider.awareness.getStates()) {
			if (clientId === own || !state?.user) continue
			peers.push({ clientId, ...(state as PresenceState) })
		}
		peers.sort((a, b) => a.clientId - b.clientId)
		this.peers.set(peers)
	}

	/** Ease our camera toward the followed person's view, so following looks smooth. */
	private stepFollow(elapsed: number) {
		const id = this.followingId.peek()
		if (id === null) return
		const peer = this.peers.peek().find((p) => p.clientId === id)
		if (!peer?.view) return
		const target = this.editor.getCameraForBounds(peer.view, { padding: 0 })
		const current = this.editor.camera.peek()
		const k = 1 - Math.exp(-elapsed / FOLLOW_EASE_MS)
		const next = easeCamera(current, target, k, this.editor.viewport.peek())
		if (next.x === current.x && next.y === current.y && next.z === current.z) return
		this.applyingFollow = true
		try {
			this.editor.stopCameraMotion()
			this.editor.setCamera(next)
		} finally {
			this.applyingFollow = false
		}
	}
}

/** Moves the camera a fraction k toward the target, interpolating the view's centre and zoom. */
function easeCamera(from: Camera, to: Camera, k: number, viewport: { w: number; h: number }): Camera {
	const center = (c: Camera) => ({ x: viewport.w / 2 / c.z - c.x, y: viewport.h / 2 / c.z - c.y })
	const a = center(from)
	const b = center(to)
	const z = from.z * Math.pow(to.z / from.z, k)
	const cx = a.x + (b.x - a.x) * k
	const cy = a.y + (b.y - a.y) * k
	const done = Math.abs(z - to.z) / to.z < 0.0005 && Math.hypot(b.x - cx, b.y - cy) * z < 0.25
	if (done) return to
	return { x: viewport.w / 2 / z - cx, y: viewport.h / 2 / z - cy, z: clamp(z, 0.001, 1000) }
}

function loadUser(): PeerUser {
	try {
		const saved = JSON.parse(localStorage.getItem(USER_KEY) ?? 'null')
		if (saved?.name && saved?.color) return saved
	} catch {
		// fall through to a random identity
	}
	const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)]
	return { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(COLORS) }
}

export function initials(name: string) {
	const parts = name.trim().split(/\s+/)
	return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}
