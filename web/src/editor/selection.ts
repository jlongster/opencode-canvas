/**
 * One selection holds three kinds of things. Item ids are stored as they are (so presence stays
 * compatible); session frames and sticky notes get a prefix. Groups are never stored in a
 * selection (a group can only be focused and linked to), but a group key names one for deep links.
 */
export type SelectionKind = 'item' | 'frame' | 'note' | 'group'

export const frameKey = (sessionId: string) => `frame:${sessionId}`
export const noteKey = (noteId: string) => `note:${noteId}`
/** A group's key, from its layout id (`${sessionId}/${name}`). */
export const groupKey = (groupId: string) => `group:${groupId}`

export function parseSelectionId(key: string): { kind: SelectionKind; id: string } {
	if (key.startsWith('frame:')) return { kind: 'frame', id: key.slice(6) }
	if (key.startsWith('note:')) return { kind: 'note', id: key.slice(5) }
	if (key.startsWith('group:')) return { kind: 'group', id: key.slice(6) }
	return { kind: 'item', id: key }
}
