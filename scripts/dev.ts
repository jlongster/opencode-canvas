export {}
// Runs the API server and the Vite dev server together.
const procs = [
	Bun.spawn(['bun', '--watch', 'server/index.ts'], { stdio: ['inherit', 'inherit', 'inherit'] }),
	Bun.spawn(['bunx', 'vite', '--config', 'web/vite.config.ts'], { stdio: ['inherit', 'inherit', 'inherit'] }),
]

const stopAll = () => {
	for (const p of procs) p.kill()
	process.exit()
}
process.on("SIGINT", stopAll)
process.on("SIGTERM", stopAll)
await Promise.race(procs.map((p) => p.exited))
stopAll()
