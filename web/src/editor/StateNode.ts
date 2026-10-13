import type { Editor } from './Editor'
import { HANDLERS, type EditorEvent, type EventOf } from './types'

export interface StateNodeConstructor {
	new (editor: Editor, parent?: StateNode): StateNode
	id: string
	initial?: string
	children?: () => StateNodeConstructor[]
}

/**
 * A node in the interaction state chart, modelled on tldraw's StateNode.
 *
 * Events enter at the root and flow down through the active branch: each node runs its own
 * handler, then hands the event to its current child. Every gesture is an explicit state
 * with explicit transitions, rather than a pile of `isDragging` flags.
 */
export abstract class StateNode {
	static id: string
	static initial?: string
	static children?: () => StateNodeConstructor[]

	readonly id: string
	readonly children: Record<string, StateNode> = {}
	current: StateNode | null = null

	constructor(
		readonly editor: Editor,
		readonly parent?: StateNode,
	) {
		const ctor = this.constructor as StateNodeConstructor
		this.id = ctor.id
		for (const Child of ctor.children?.() ?? []) this.children[Child.id] = new Child(editor, this)
	}

	/** Path of the active branch below this node, e.g. "select.brushing". */
	getActivePath(): string {
		const parts: string[] = []
		for (let n = this.current; n; n = n.current) parts.push(n.id)
		return parts.join('.')
	}

	handleEvent(event: EditorEvent) {
		const child = this.current
		const handler = (this as any)[HANDLERS[event.name]] as ((e: EditorEvent) => void) | undefined
		handler?.call(this, event)
		// Only forward if the handler didn't transition us away from this child.
		if (child && this.current === child) child.handleEvent(event)
	}

	/** Transition to a child of this node, e.g. `transition('brushing')` or `transition('select.idle')`. */
	transition(path: string, info?: unknown) {
		const [id, ...rest] = path.split('.')
		const next = this.children[id]
		if (!next) throw new Error(`${this.id}: no child state "${id}"`)
		const prev = this.current
		prev?.exit(info, id)
		this.current = next
		next.enter(info, prev?.id ?? '', rest.length === 0)
		if (rest.length) next.transition(rest.join('.'), info)
		this.editor.onStateChange()
	}

	enter(info: unknown, from: string, enterInitialChild = true) {
		this.onEnter?.(info, from)
		const initial = (this.constructor as StateNodeConstructor).initial
		if (enterInitialChild && initial && this.current === null) {
			this.current = this.children[initial]
			this.current.enter(info, '')
		}
	}

	exit(info: unknown, to: string) {
		this.current?.exit(info, to)
		this.current = null
		this.onExit?.(info, to)
	}

	onEnter?(info: unknown, from: string): void
	onExit?(info: unknown, to: string): void
	onPointerDown?(e: EventOf<'pointer_down'>): void
	onPointerMove?(e: EventOf<'pointer_move'>): void
	onPointerUp?(e: EventOf<'pointer_up'>): void
	onKeyDown?(e: EventOf<'key_down'>): void
	onKeyUp?(e: EventOf<'key_up'>): void
	onDoubleClick?(e: EventOf<'double_click'>): void
	onTick?(e: EventOf<'tick'>): void
	onCancel?(e: EventOf<'cancel'>): void
}
