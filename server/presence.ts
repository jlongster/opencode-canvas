import { setServerPresence } from './rooms'

/** rooms drop presence states not renewed within 30s (y-protocols' outdatedTimeout) */
export const SERVER_PRESENCE_RENEW_MS = 10_000

/**
 * One presence the server publishes into a canvas's room under its own awareness client id (MCP
 * agents, conjured worms). Keeps the clock growing, remembers the last state so it can be renewed
 * (which also brings it back into a room that was unloaded and loaded again), and leaves on demand.
 */
export class ServerPresence {
	readonly clientId = crypto.getRandomValues(new Uint32Array(1))[0]
	private clock = 0
	private state: Record<string, unknown> | null = null
	private left = false

	constructor(readonly canvasId: string) {}

	async set(state: Record<string, unknown>) {
		if (this.left) return
		this.state = state
		this.clock++
		await setServerPresence(`canvas-${this.canvasId}`, this.clientId, this.clock, state)
	}

	/** Publishes the last state again, so the room doesn't time it out. */
	async renew() {
		if (this.state) await this.set(this.state)
	}

	async leave() {
		if (this.left) return
		this.left = true
		this.state = null
		this.clock++
		await setServerPresence(`canvas-${this.canvasId}`, this.clientId, this.clock, null)
	}
}
