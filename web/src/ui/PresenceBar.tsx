import { useEffect, useRef, useState } from 'react'
import { COLORS, initials, type Presence } from '../multiplayer/Presence'
import { useValue } from './useValue'

const MAX_SHOWN = 6

/** Overlapping avatars of everyone here. Click someone to follow them; click yourself to rename. */
export function PresenceBar({ presence }: { presence: Presence }) {
	const peers = useValue(() => presence.peers.get().map((p) => ({ id: p.clientId, ...p.user })), [presence])
	const me = useValue(() => presence.me.get(), [presence])
	const following = useValue(() => presence.followingId.get(), [presence])
	const status = useValue(() => presence.status.get(), [presence])
	const [editing, setEditing] = useState(false)

	const shown = peers.slice(0, MAX_SHOWN)
	const hidden = peers.length - shown.length

	return (
		<div className="presence" onPointerDown={(e) => e.stopPropagation()}>
			<div className="avatars">
				{shown.map((p) => (
					<button
						key={p.id}
						className={`avatar${following === p.id ? ' following' : ''}`}
						style={{ background: p.color, ['--ring' as string]: p.color }}
						title={following === p.id ? `Stop following ${p.name}` : `Follow ${p.name}`}
						onClick={() => presence.toggleFollow(p.id)}
					>
						{initials(p.name)}
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
