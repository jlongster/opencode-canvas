import type { Editor } from '../editor/Editor'
import { populating } from '../opencode/populate'
import { useFrameAnchor } from './frameAnchor'
import { useValue } from './useValue'
import './populate.css'

/** frames narrower than this (screen px) show the progress under the title instead */
const ROW_MIN_W = 440
/** room left for the buttons at the right of a frame's title */
const BUTTONS_W = 120
const PILL_H = 28

/** "Finding media…" on the title row of each frame this tab is filling in (see opencode/populate.ts). */
export function PopulateProgress({ editor }: { editor: Editor }) {
	const ids = useValue(() => Object.keys(populating.get()).join(' '))
	if (!ids) return null
	return (
		<>
			{ids.split(' ').map((id) => (
				<FrameProgress key={id} editor={editor} sessionId={id} />
			))}
		</>
	)
}

function FrameProgress({ editor, sessionId }: { editor: Editor; sessionId: string }) {
	const anchor = useFrameAnchor(editor, sessionId)
	const vw = useValue(() => editor.viewport.get().w, [editor])
	const status = useValue(() => populating.get()[sessionId], [sessionId])
	if (!anchor?.onScreen || !status) return null
	// On the title's row, left of the frame's buttons (the prompt opens under the title); under the title in narrow frames.
	const roomy = anchor.right - anchor.x >= ROW_MIN_W
	const style = roomy
		? { left: Math.min(anchor.right - BUTTONS_W, vw - 16), top: Math.round((anchor.top + anchor.bottom) / 2 - PILL_H / 2), transform: 'translateX(-100%)' }
		: { left: anchor.x + 12, top: anchor.bottom + 12 }
	return (
		<div className="populate-progress" role="status" style={style}>
			<span className="populate-spinner" />
			{status.state === 'finding' ? 'Finding media…' : `Adding ${status.done}/${status.total}…`}
		</div>
	)
}
