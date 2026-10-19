import { useEffect, useRef, useState } from 'react'
import { COLORS, initials, type Presence } from '../multiplayer/Presence'
import { NARROW_QUERY, useMediaQuery } from './useMediaQuery'
import { useValue } from './useValue'

const MAX_SHOWN = 6
/** On phones the rest collapse into the "+N" count, leaving room for the title and toolbar. */
const MAX_SHOWN_NARROW = 1

/** Overlapping avatars of everyone here. Click someone to follow them; click yourself to rename. */
export function PresenceBar({ presence }: { presence: Presence }) {
	const peers = useValue(
		() =>
			presence.peers
				.get()
				.filter((p) => !p.user.agent || p.user.conjured)
				.map((p) => ({ id: p.clientId, ...p.user })),
		[presence],
	)
	const me = useValue(() => presence.me.get(), [presence])
	const following = useValue(() => presence.followingId.get(), [presence])
	const status = useValue(() => presence.status.get(), [presence])
	const [editing, setEditing] = useState(false)
	const narrow = useMediaQuery(NARROW_QUERY)

	const shown = peers.slice(0, narrow ? MAX_SHOWN_NARROW : MAX_SHOWN)
	const hidden = peers.length - shown.length

	return (
		<div className="presence" onPointerDown={(e) => e.stopPropagation()}>
			<div className="avatars">
				{shown.map((p) => (
					<button
						key={p.id}
						className={`avatar${p.agent ? ' agent' : ''}${following === p.id ? ' following' : ''}`}
						style={p.agent ? { color: p.color, ['--ring' as string]: p.color } : { background: p.color, ['--ring' as string]: p.color }}
						title={
							(p.agent ? `AI agent: ${p.name}\n` : '') + (following === p.id ? `Stop following ${p.name}` : `Follow ${p.name}`)
						}
						onClick={() => presence.toggleFollow(p.id)}
					>
						{p.agent ? <LooperGlyph /> : initials(p.name)}
					</button>
				))}
				{hidden > 0 && <div className="avatar more">+{hidden}</div>}
				<button
					className="avatar me"
					style={{ background: me.color }}
					title={`You (${me.name}): click to change your name`}
					onClick={() => setEditing((v) => !v)}
				>
					{initials(me.name)}
					<span className={`presence-dot ${status}`} />
				</button>
			</div>
			{editing && <NameEditor presence={presence} onDone={() => setEditing(false)} />}
		</div>
	)
}

/** Creatures are loopers (see Looper.ts): an arched inchworm with one eye, in the session's colour. */
function LooperGlyph() {
	return (
		<svg className="agent-glyph" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
			<path className="agent-glyph-body" d="M5.6 13.6 C5.1 7.2 7.4 4.6 10.4 4.6 C13.5 4.6 15.3 7.2 15.3 15" />
			<circle className="agent-glyph-head" cx="5.6" cy="14.3" r="2.9" />
			<circle className="agent-glyph-eye" cx="5.7" cy="14.4" r="2" />
			<circle className="agent-glyph-pupil" cx="6.1" cy="14.7" r="1" />
			<path className="agent-glyph-lid" d="M3.7 13.8 A2 2 0 0 1 7.7 13.8 Z" />
		</svg>
	)
}

function NameEditor({ presence, onDone }: { presence: Presence; onDone: () => void }) {
	const me = presence.me.peek()
	const [name, setName] = useState(me.name)
	const inputRef = useRef<HTMLInputElement>(null)
	useEffect(() => inputRef.current?.select(), [])
	const color = useValue(() => presence.me.get().color, [presence])

	const save = () => {
		presence.setName(name)
		onDone()
	}

	return (
		<div className="name-editor">
			<label>Your name</label>
			<input
				ref={inputRef}
				value={name}
				maxLength={40}
				onChange={(e) => setName(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter') save()
					if (e.key === 'Escape') onDone()
				}}
			/>
			<div className="swatches">
				{COLORS.map((c) => (
					<button
						key={c}
						className={`swatch${c === color ? ' active' : ''}`}
						style={{ background: c }}
						title="Use this colour"
						onClick={() => presence.setColor(c)}
					/>
				))}
			</div>
			<button className="save" onClick={save}>
				Save
			</button>
		</div>
	)
}

/** A coloured frame around the screen while following someone. */
export function FollowIndicator({ presence }: { presence: Presence }) {
	const followed = useValue(() => {
		const id = presence.followingId.get()
		return presence.peers.get().find((p) => p.clientId === id)?.user ?? null
	}, [presence])
	if (!followed) return null
	return (
		<div className="follow-frame" style={{ ['--ring' as string]: followed.color }}>
			<div className="follow-tag" onPointerDown={(e) => e.stopPropagation()}>
				Following {followed.name}
				<button onClick={() => presence.followingId.set(null)}>Stop</button>
			</div>
		</div>
	)
}
