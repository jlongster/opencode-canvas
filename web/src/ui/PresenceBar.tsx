import { useEffect, useRef, useState } from 'react'
import { COLORS, initials, type Presence } from '../multiplayer/Presence'
import { useValue } from './useValue'

const MAX_SHOWN = 6

/** Overlapping avatars of everyone here. Click someone to follow them; click yourself to rename. */
export function PresenceBar({ presence }: { presence: Presence }) {
	const peers = useValue(
		() => presence.peers.get().map((p) => ({ id: p.clientId, ...p.user, chat: p.chat ?? null })),
		[presence],
	)
	const me = useValue(() => presence.me.get(), [presence])
	const following = useValue(() => presence.followingId.get(), [presence])
	const status = useValue(() => presence.status.get(), [presence])
	const [editing, setEditing] = useState(false)

	const shown = peers.slice(0, MAX_SHOWN)
	const hidden = peers.length - shown.length
	const activity = peers.filter((p) => p.agent && p.chat)

	return (
		<div className="presence" onPointerDown={(e) => e.stopPropagation()}>
			<div className="avatars">
				{shown.map((p) => (
					<button
						key={p.id}
						className={`avatar${p.agent ? ' agent' : ''}${following === p.id ? ' following' : ''}`}
						style={{ background: p.color, ['--ring' as string]: p.color }}
						title={
							(p.agent ? `AI agent: ${p.name}\n` : '') + (following === p.id ? `Stop following ${p.name}` : `Follow ${p.name}`)
						}
						onClick={() => presence.toggleFollow(p.id)}
					>
						{p.agent ? <AgentGlyph /> : initials(p.name)}
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
			{activity.length > 0 && (
				<div className="agent-activity">
					{activity.map((p) => (
						// keyed by the message so each new one starts its fade afresh
						<div key={`${p.id}:${p.chat}`} className="agent-activity-line" style={{ ['--ring' as string]: p.color }}>
							<AgentGlyph />
							<span className="agent-activity-name">{p.name}</span>
							<span className="agent-activity-text">{p.chat}</span>
						</div>
					))}
				</div>
			)}
			{editing && <NameEditor presence={presence} onDone={() => setEditing(false)} />}
		</div>
	)
}

/** A one-eyed robot with a sparkling antenna: agents aren't people, so they don't get initials. */
function AgentGlyph() {
	return (
		<svg className="agent-glyph" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
			<path className="agent-glyph-spark" d="M9 0.6 L9.7 2.3 L11.4 3 L9.7 3.7 L9 5.4 L8.3 3.7 L6.6 3 L8.3 2.3 Z" />
			<rect x="3" y="6.2" width="12" height="9.6" rx="3.4" />
			<circle className="agent-glyph-eye" cx="9" cy="11" r="2.6" />
			<circle className="agent-glyph-pupil" cx="9.7" cy="10.4" r="0.9" />
			<path d="M3 10 H1.6 M15 10 H16.4" strokeWidth="1.4" strokeLinecap="round" />
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
