/**
 * A session's running tool call as one line of its frame's printout: a verb and a short argument,
 * "Read src/App.tsx", "Edit server/busy.ts +42 −18", "Bash bun test", "Task spawn 1990s early".
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
			return file ? `Read ${short(file)}` : 'Read'
		case 'write':
			return file ? `Write ${short(file)}${input?.content ? ` +${lines(str(input.content))}` : ''}` : 'Write'
		case 'edit':
		case 'multiedit': {
			const added = lines(str(input?.newString ?? input?.new_string))
			const removed = lines(str(input?.oldString ?? input?.old_string))
			const counts = added || removed ? ` +${added} −${removed}` : ''
			return file ? `Edit ${short(file)}${counts}` : 'Edit'
		}
		case 'patch':
		case 'apply_patch': {
			const text = str(input?.patchText ?? input?.patch ?? input?.input)
			const target = file || /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(text)?.[1] || ''
			const added = text.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
			const removed = text.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length
			return `Edit${target ? ` ${short(relative(target, directory))}` : ''}${added || removed ? ` +${added} −${removed}` : ''}`
		}
		case 'bash':
		case 'shell': {
			const cmd = short(str(input?.command))
			return cmd ? `Bash ${cmd}` : 'Bash'
		}
		case 'grep':
		case 'codesearch': {
			const q = short(str(input?.pattern ?? input?.query))
			return q ? `Grep ${q}` : 'Grep'
		}
		case 'glob': {
			const q = short(str(input?.pattern))
			return q ? `Glob ${q}` : 'Glob'
		}
		case 'list':
		case 'ls':
			return file ? `List ${short(file)}` : 'List'
		case 'task':
		case 'subagent': {
			const what = short(str(input?.description ?? input?.prompt))
			return what ? `Task spawn ${what}` : 'Task spawn'
		}
		case 'webfetch': {
			const u = short(str(input?.url))
			return u ? `Fetch ${u}` : 'Fetch'
		}
		case 'websearch': {
			const q = short(str(input?.query))
			return q ? `Search ${q}` : 'Search'
		}
		case 'todowrite':
		case 'todoread':
			return 'Plan'
		case 'question':
			return 'Ask'
		case '':
			return 'Work'
		default: {
			const arg = short(file || str(input?.url ?? input?.query ?? input?.title ?? ''))
			return `${name.charAt(0).toUpperCase() + name.slice(1)}${arg ? ` ${arg}` : ''}`
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
