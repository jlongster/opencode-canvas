export {}
// Seeds a canvas with sample sessions by posting local files to the API.
// Usage: bun scripts/seed.ts [server-url] [canvas-id | "new"] [dir...]
// With "new" (the default) a canvas called "Seed" is created.
const [base = 'http://localhost:4410', canvasArg = 'new', ...dirs] = process.argv.slice(2)
const MEDIA = /\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i

const { readdir } = await import('node:fs/promises')
const { join, basename } = await import('node:path')

let canvasId = canvasArg
if (canvasArg === 'new') {
	const res = await fetch(`${base}/api/canvases`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ title: 'Seed' }),
	})
	canvasId = ((await res.json()) as { id: string }).id
	console.log('created canvas', canvasId)
}

for (const dir of dirs.length ? dirs : ['/root/imagegen']) {
	const files = (await readdir(dir)).filter((f) => MEDIA.test(f)).sort()
	if (!files.length) continue
	// The server only accepts OpenCode-shaped session ids: "ses_" + 26 characters.
	const sessionId = `ses_seed${basename(dir).replace(/[^A-Za-z0-9]/g, '')}`.padEnd(30, '0').slice(0, 30)
	const sessionUrl = `${base}/api/canvases/${canvasId}/sessions/${sessionId}`
	await fetch(sessionUrl, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ title: basename(dir) }),
	})
	for (const f of files) {
		const res = await fetch(`${sessionUrl}/items`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path: join(dir, f), caption: f }),
		})
		console.log(res.status, sessionId, f)
	}
}
