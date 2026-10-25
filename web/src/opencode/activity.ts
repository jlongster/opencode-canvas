/**
 * A session's running tool call as one line of its frame's printout: a verb and a short argument,
 * "READ src/App.tsx", "EDIT server/busy.ts +42 −18", "BASH bun test", "TASK spawn 1990s early".
 */
const ARG_MAX = 72

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const short = (s: string) => {
	const line = s.split('\n')[0].trim().replace(/\s+/g, ' ')
	return line.length > ARG_MAX ? line.slice(0, ARG_MAX - 1) + '…' : line
}
const lines = (s: string) => (s ? s.split('\n').length : 0)

/** A path relative to the session's directory, when it's in it. */
function relative(path: string, directory?: string) {
	if (directory && path.startsWith(directory.replace(/\/?$/, '/'))) return path.slice(directory.replace(/\/?$/, '/').length)
	return path
}

export function summariseTool(name: string, input: Record<string, unknown> | undefined, directory?: string): string {
	const file = relative(str(input?.filePath ?? input?.file_path ?? input?.path ?? input?.file), directory)
	switch (name.toLowerCase()) {
		case 'read':
			return file ? `READ ${short(file)}` : 'READ'
		case 'write':
			return file ? `WRITE ${short(file)}${input?.content ? ` +${lines(str(input.content))}` : ''}` : 'WRITE'
		case 'edit':
		case 'multiedit': {
			const added = lines(str(input?.newString ?? input?.new_string))
			const removed = lines(str(input?.oldString ?? input?.old_string))
			const counts = added || removed ? ` +${added} −${removed}` : ''
			return file ? `EDIT ${short(file)}${counts}` : 'EDIT'
		}
		case 'patch':
		case 'apply_patch': {
			const text = str(input?.patchText ?? input?.patch ?? input?.input)
			const target = file || /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(text)?.[1] || ''
			const added = text.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
			const removed = text.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length
			return `EDIT${target ? ` ${short(relative(target, directory))}` : ''}${added || removed ? ` +${added} −${removed}` : ''}`
		}
		case 'bash':
		case 'shell': {
			const cmd = short(str(input?.command))
			return cmd ? `BASH ${cmd}` : 'BASH'
		}
		case 'grep':
		case 'codesearch': {
			const q = short(str(input?.pattern ?? input?.query))
			return q ? `GREP ${q}` : 'GREP'
		}
		case 'glob': {
			const q = short(str(input?.pattern))
			return q ? `GLOB ${q}` : 'GLOB'
		}
		case 'list':
		case 'ls':
			return file ? `LIST ${short(file)}` : 'LIST'
		case 'task':
		case 'subagent': {
			const what = short(str(input?.description ?? input?.prompt))
			return what ? `TASK spawn ${what}` : 'TASK spawn'
		}
		case 'webfetch': {
			const u = short(str(input?.url))
			return u ? `FETCH ${u}` : 'FETCH'
		}
		case 'websearch': {
			const q = short(str(input?.query))
			return q ? `SEARCH ${q}` : 'SEARCH'
		}
		case 'todowrite':
		case 'todoread':
			return 'PLAN'
		case 'question':
			return 'ASK'
		case '':
			return 'WORK'
		default: {
			const arg = short(file || str(input?.url ?? input?.query ?? input?.title ?? ''))
			return `${name.toUpperCase()}${arg ? ` ${arg}` : ''}`
		}
	}
}

/** "anthropic/claude-opus-5-5" → "opus-5.5"; anything else as it is, without its provider. */
export function shortModel(id: string): string {
	const bare = id.replace(/^.*\//, '')
	const claude = /^claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?/.exec(bare)
	if (claude) return `${claude[1]}-${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
	return bare.length > 24 ? bare.slice(0, 23) + '…' : bare
}
