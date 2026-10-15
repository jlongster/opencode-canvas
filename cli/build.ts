/**
 * Builds the publishable package: the canvas web app (vite, from the repo root) copied into app/,
 * and the CLI bundled into one Node-compatible file, dist/cli.js (dependencies included, so
 * `bunx opencode-canvas` installs nothing else).
 */
import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const cli = import.meta.dir
const root = join(cli, '..')
const pkg = (await Bun.file(join(cli, 'package.json')).json()) as { version: string }

const vite = Bun.spawnSync(['bun', 'run', 'build'], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
if (vite.exitCode !== 0) process.exit(vite.exitCode ?? 1)

await rm(join(cli, 'app'), { recursive: true, force: true })
await cp(join(root, 'web/dist'), join(cli, 'app'), { recursive: true })

await rm(join(cli, 'dist'), { recursive: true, force: true })
await mkdir(join(cli, 'dist'))
const result = await Bun.build({
	entrypoints: [join(cli, 'src/index.ts')],
	outdir: join(cli, 'dist'),
	naming: 'cli.js',
	target: 'node',
	format: 'esm',
	minify: true,
	define: { CLI_VERSION: JSON.stringify(pkg.version) },
	banner: '#!/usr/bin/env node',
})
if (!result.success) {
	for (const log of result.logs) console.error(log)
	process.exit(1)
}
const out = join(cli, 'dist/cli.js')
await Bun.$`chmod +x ${out}`
console.log(`built ${out} (${(Bun.file(out).size / 1024).toFixed(0)} KB) and app/ from web/dist`)
