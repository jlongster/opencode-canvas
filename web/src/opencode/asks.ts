/**
 * What an OpenCode session is waiting on its user for: questions (its `question` tool, and any other
 * form, see OpenCode's Form API: GET /api/session/:id/form, POST …/form/:formID/reply, DELETE to
 * dismiss; events form.created / form.replied / form.cancelled) and tool permission requests (GET
 * /api/session/:id/permission, POST …/permission/:requestID/reply with once / always / reject;
 * events permission.asked / permission.replied). The session keeps running, blocked, until each is
 * answered.
 */
import { withServer } from './pairings'

export interface AskOption {
	value: string
	label: string
	description?: string
}

/** One question of a form, as the stack asks it. */
export interface AskField {
	key: string
	/** its short header (the question tool's `header`), and the question itself */
	title: string
	text: string
	/** pick one option, several, yes/no, or type something (a number for number/integer) */
	type: 'choice' | 'multi' | 'boolean' | 'text' | 'number' | 'integer' | 'external'
	options: AskOption[]
	/** a typed answer is allowed besides the options */
	custom: boolean
	required: boolean
	placeholder?: string
	/** external fields: a page to open */
	url?: string
}

export interface QuestionAsk {
	kind: 'question'
	id: string
	sessionId: string
	title: string
	fields: AskField[]
}

export interface PermissionAsk {
	kind: 'permission'
	id: string
	sessionId: string
	action: string
	resources: string[]
	/** what "always" would allow from now on */
	save: string[]
	/** e.g. "Run `ls -la`?" */
	title: string
}

export type Ask = QuestionAsk | PermissionAsk

/** The answer to one field: an option's value (or typed text), several, yes/no, or a number. */
export type AskValue = string | string[] | boolean | number

const TEXT_MAX = 160

type Raw = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export function parseForm(raw: unknown): QuestionAsk | null {
	const f = raw as Raw | null
	if (!f || typeof f.id !== 'string' || typeof f.sessionID !== 'string' || !Array.isArray(f.fields)) return null
	const fields: AskField[] = []
	for (const x of f.fields as Raw[]) {
		if (!x || typeof x.key !== 'string' || x.hidden === true) continue
		const options = Array.isArray(x.options)
			? (x.options as Raw[])
					.filter((o) => o && typeof o.value === 'string')
					.map((o) => ({ value: str(o.value), label: str(o.label) || str(o.value), ...(str(o.description) ? { description: str(o.description) } : {}) }))
			: []
		const t = x.type
		const type: AskField['type'] =
			t === 'multiselect' ? 'multi' : t === 'boolean' ? 'boolean' : t === 'number' || t === 'integer' || t === 'external' ? t : options.length ? 'choice' : 'text'
		fields.push({
			key: x.key,
			title: str(x.title),
			text: str(x.description),
			type,
			options,
			custom: type === 'text' || x.custom === true,
			required: x.required === true,
			...(str(x.placeholder) ? { placeholder: str(x.placeholder) } : {}),
			...(str(x.url) ? { url: str(x.url) } : {}),
		})
	}
	return { kind: 'question', id: f.id, sessionId: f.sessionID, title: str(f.title), fields }
}

export function parsePermission(raw: unknown): PermissionAsk | null {
	const p = raw as Raw | null
	if (!p || typeof p.id !== 'string' || typeof p.sessionID !== 'string') return null
	const action = str(p.action)
	const resources = strs(p.resources)
	return { kind: 'permission', id: p.id, sessionId: p.sessionID, action, resources, save: strs(p.save), title: permissionTitle(action, resources, (p.metadata as Raw) ?? {}) }
}

/** "Run `rm -rf dist`?", "Edit `src/a.ts`?" and the like. */
function permissionTitle(action: string, resources: string[], metadata: Raw): string {
	const what = resources.filter((r) => r && r !== '*')
	const list = what.length ? what.map((r) => `\`${r}\``).join(', ') : ''
	switch (action) {
		case 'shell':
		case 'bash': {
			const cmd = str(metadata.command) || what.join(' && ')
			return cmd ? `Run \`${cmd}\`?` : 'Run a shell command?'
		}
		case 'edit':
		case 'write':
		case 'patch':
			return list ? `Edit ${list}?` : 'Edit files?'
		case 'read':
			return list ? `Read ${list}?` : 'Read files?'
		case 'external_directory':
			return list ? `Work outside its directory, in ${list}?` : 'Work outside its directory?'
		case 'webfetch':
			return list ? `Fetch ${list}?` : 'Fetch a web page?'
		case 'websearch':
			return list ? `Search the web for ${list}?` : 'Search the web?'
		case 'task':
		case 'subagent':
			return list ? `Start a subagent (${list})?` : 'Start a subagent?'
		default:
			return `Use ${action || 'a tool'}${list ? ` on ${list}` : ''}?`
	}
}

/** One line for the ask, for whoever only sees that it's waiting. */
export function askText(ask: Ask): string {
	const text =
		ask.kind === 'permission'
			? ask.title
			: (ask.fields.map((f) => f.text || f.title).find(Boolean) ?? (ask.title && ask.title !== 'Questions' ? ask.title : 'A question'))
	const flat = text.replace(/\s+/g, ' ').trim()
	return flat.length > TEXT_MAX ? flat.slice(0, TEXT_MAX - 1) + '…' : flat
}

/** How many things the asks want answered: each question, and each permission. */
export const askCount = (asks: Ask[]) => asks.reduce((n, a) => n + (a.kind === 'question' ? Math.max(1, a.fields.length) : 1), 0)

/** The sessions' pending questions and permission requests, oldest first; null when it couldn't list them all. */
export async function listAsks(serverKey: string, sessionIds: string[]): Promise<Ask[] | null> {
	try {
		const lists = await withServer(serverKey, (c) =>
			Promise.all(
				sessionIds.flatMap((sessionID) => [
					c.session.form.list({ sessionID }, { signal: AbortSignal.timeout(10_000) }).then((l) => l.map(parseForm)),
					c.permission.list({ sessionID }, { signal: AbortSignal.timeout(10_000) }).then((l) => l.map(parsePermission)),
				]),
			),
		)
		return lists.flat().filter((a): a is Ask => !!a)
	} catch {
		return null
	}
}

export async function answerQuestion(serverKey: string, ask: QuestionAsk, answer: Record<string, AskValue>) {
	await withServer(serverKey, (c) => c.session.form.reply({ sessionID: ask.sessionId, formID: ask.id, answer }, { signal: AbortSignal.timeout(10_000) }))
}

export async function dismissQuestion(serverKey: string, ask: QuestionAsk) {
	await withServer(serverKey, (c) => c.session.form.cancel({ sessionID: ask.sessionId, formID: ask.id }, { signal: AbortSignal.timeout(10_000) }))
}

export async function replyPermission(serverKey: string, ask: PermissionAsk, decision: 'once' | 'always' | 'reject', message?: string) {
	await withServer(serverKey, (c) =>
		c.permission.reply(
			{ sessionID: ask.sessionId, requestID: ask.id, decision, ...(message?.trim() ? { message: message.trim() } : {}) },
			{ signal: AbortSignal.timeout(10_000) },
		),
	)
}

/** Whether an OpenCode event is about asks (a question or a permission request coming or going). */
export const isAskEvent = (type: string) => type.startsWith('form.') || type === 'permission.asked' || type === 'permission.replied'
