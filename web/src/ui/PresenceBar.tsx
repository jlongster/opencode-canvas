import { useEffect, useRef, useState } from 'react'
import { NATIVE, POINTER_EYE, pointerD } from '../multiplayer/Pointer'
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
						{p.agent ? <PointerGlyph /> : initials(p.name)}
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

/** Creatures are eye pointers (see Pointer.ts), in the session's colour. */
const GLYPH = { d: pointerD(15.5), eye: { x: POINTER_EYE.x * 15.5, y: POINTER_EYE.y * 15.5, r: POINTER_EYE.r * 15.5 * 1.25 } }

function PointerGlyph() {
	const { eye } = GLYPH
	const pr = eye.r * 0.58
	return (
		<svg className="agent-glyph" width="20" height="20" viewBox="-10 -10 20 20" aria-hidden="true">
			<path className="agent-glyph-body" d={GLYPH.d} />
			<circle className="agent-glyph-eye" cx={eye.x} cy={eye.y} r={eye.r} />
			<g className="agent-glyph-pupil">
				<circle cx={eye.x + Math.cos(NATIVE) * eye.r * 0.3} cy={eye.y + Math.sin(NATIVE) * eye.r * 0.3} r={pr} />
				<circle className="agent-glyph-glint" cx={eye.x + Math.cos(NATIVE) * eye.r * 0.3 + pr * 0.36} cy={eye.y + Math.sin(NATIVE) * eye.r * 0.3 - pr * 0.4} r={pr * 0.32} />
			</g>
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
