import type { Vec } from './geometry'

export type Target =
	| { type: 'item'; id: string }
	| { type: 'section'; id: string }
	/** a session frame's title strip */
	| { type: 'frame_title'; id: string }
	/** a named group's heading (id is the group's layout id) */
	| { type: 'group_heading'; id: string }
	| { type: 'canvas' }

export interface Modifiers {
	shiftKey: boolean
	altKey: boolean
	ctrlKey: boolean
	metaKey: boolean
}

export type PointerEventInfo = Modifiers & {
	name: 'pointer_down' | 'pointer_move' | 'pointer_up'
	/** screen-space point, relative to the canvas container */
	point: Vec
	button: number
	target: Target
}

export type KeyEventInfo = Modifiers & {
	name: 'key_down' | 'key_up'
	key: string
	code: string
}

export type EditorEvent =
	| PointerEventInfo
	| KeyEventInfo
	| (Modifiers & { name: 'double_click'; point: Vec; target: Target })
	| { name: 'tick'; elapsed: number }
	| { name: 'cancel' }

export type EventName = EditorEvent['name']

export const HANDLERS = {
	pointer_down: 'onPointerDown',
	pointer_move: 'onPointerMove',
	pointer_up: 'onPointerUp',
	key_down: 'onKeyDown',
	key_up: 'onKeyUp',
	double_click: 'onDoubleClick',
	tick: 'onTick',
	cancel: 'onCancel',
} as const satisfies Record<EventName, string>

export type EventOf<N extends EventName> = N extends PointerEventInfo['name']
	? PointerEventInfo
	: N extends KeyEventInfo['name']
		? KeyEventInfo
		: Extract<EditorEvent, { name: N }>
