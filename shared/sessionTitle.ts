import type { OpenCodeSessionInfo, Session } from './types'

/** A frame's title: its OpenCode session's title once a paired browser reported it, else the title it was posted with. */
export function frameTitle(postedTitle: string | undefined, opencode: OpenCodeSessionInfo | undefined): string {
	return opencode?.title.trim() || postedTitle?.trim() || ''
}

/** OpenCode deleted the frame's session: the frame and its items stay, marked as ended. */
export const isEnded = (s: Pick<Session, 'opencode'>) => !!s.opencode?.deleted
