export {}
// Seeds the canvas with sample sessions by posting local files to the API.
// Usage: bun scripts/seed.ts [server-url] [dir...]
const [base = 'http://localhost:4410', ...dirs] = process.argv.slice(2)
const MEDIA = /\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i

const { readdir } = await import('node:fs/promises')
const { join, basename } = await import('node:path')

for (const dir of dirs.length ? dirs : ['/root/imagegen']) {
	const files = (await readdir(dir)).filter((f) => MEDIA.test(f)).sort()
	if (!files.length) continue
	// The server only accepts OpenCode-style session ids.
	const sessionId = `ses_seed${basename(dir).replace(/[^A-Za-z0-9]/g, '')}`.padEnd(12, '0')
	await fetch(`${base}/api/sessions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ id: sessionId, title: basename(dir) }),
	})
	for (const f of files) {
		const res = await fetch(`${base}/api/sessions/${sessionId}/items`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path: join(dir, f), caption: f }),
		})
		console.log(res.status, sessionId, f)
	}
}
