import { useEffect, useRef } from 'react'
import type { Editor } from '../editor/Editor'
import type { Vec } from '../editor/geometry'
import type { Presence } from '../multiplayer/Presence'
import { useValue } from './useValue'

/** Our own cursor chat bubble: an input while typing, then the sent message until it fades. */
export function CursorChat({ editor, presence }: { editor: Editor; presence: Presence }) {
	const chat = useValue(() => presence.chat.get(), [presence])
	const open = useValue(() => presence.chatOpen.get(), [presence])
	const color = useValue(() => presence.me.get().color, [presence])
	const lastPoint = useRef<Vec>({ x: 0, y: 0 })
	const point = useValue(() => {
		if (presence.chat.get() === null) return null
		editor.camera.get()
		const p = editor.pointerPage.get()
		return p ? editor.pageToScreen(p) : null
	}, [editor, presence])
	if (point) lastPoint.current = point
	const inputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		if (open) inputRef.current?.focus()
	}, [open])

	if (chat === null) return null
	const { x, y } = lastPoint.current

	return (
		<div className={`cursor-chat${open ? '' : ' sent'}`} style={{ transform: `translate(${x + 16}px, ${y + 18}px)`, background: color }}>
			{open ? (
				<input
					ref={inputRef}
					value={chat}
					placeholder="Say something"
					maxLength={140}
					onChange={(e) => presence.setChatText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') presence.commitChat()
						if (e.key === 'Escape') presence.closeChat()
						e.stopPropagation()
					}}
					onBlur={() => presence.commitChat()}
				/>
			) : (
				<span>{chat}</span>
			)}
		</div>
	)
}
