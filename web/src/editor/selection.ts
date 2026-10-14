/**
 * One selection holds three kinds of things. Item ids are stored as they are (so presence stays
 * compatible); session frames and sticky notes get a prefix.
 */
export type SelectionKind = 'item' | 'frame' | 'note'

export const frameKey = (sessionId: string) => `frame:${sessionId}`
export const noteKey = (noteId: string) => `note:${noteId}`

export function parseSelectionId(key: string): { kind: SelectionKind; id: string } {
	if (key.startsWith('frame:')) return { kind: 'frame', id: key.slice(6) }
	if (key.startsWith('note:')) return { kind: 'note', id: key.slice(5) }
	return { kind: 'item', id: key }
}
