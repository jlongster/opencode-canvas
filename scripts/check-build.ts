// Fails if the committed web/dist isn't what `bun run build` makes from the current source:
// `bunx github:jlongster/opencode-canvas` serves web/dist as committed, so run this before pushing.
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const root = join(import.meta.dir, '..')
const dist = join(root, 'web/dist')
const out = await mkdtemp(join(tmpdir(), 'canvas-dist-'))

async function files(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
	return entries.filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name))).sort()
}

try {
	const build = Bun.spawnSync(['bunx', 'vite', 'build', '--config', 'web/vite.config.ts', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], {
		cwd: root,
		stdout: 'inherit',
		stderr: 'inherit',
	})
	if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)
	const [want, have] = await Promise.all([files(out), files(dist)])
	const stale = [
		...want.filter((f) => !have.includes(f)).map((f) => `missing ${f}`),
		...have.filter((f) => !want.includes(f)).map((f) => `extra ${f}`),
	]
	for (const f of want.filter((f) => have.includes(f))) {
		const [a, b] = await Promise.all([Bun.file(join(out, f)).bytes(), Bun.file(join(dist, f)).bytes()])
		if (Buffer.compare(a, b) !== 0) stale.push(`changed ${f}`)
	}
	if (stale.length) {
		console.error(`web/dist is out of date (${stale.join(', ')}). Run \`bun run build\` and commit web/dist.`)
		process.exit(1)
	}
	console.log('web/dist is up to date')
} finally {
	await rm(out, { recursive: true, force: true })
}
