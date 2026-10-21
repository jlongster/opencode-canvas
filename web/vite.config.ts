import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const api = `http://localhost:${process.env.PORT ?? 4410}`

export default defineConfig({
	root: __dirname,
	// Assets live under /canvas/ so the same build works directly (the server strips the prefix)
	// and behind the website's /canvas proxy.
	base: '/canvas/',
	plugins: [react()],
	server: {
		port: 5173,
		host: true,
		allowedHosts: ['jamesbox.exe.xyz', '.exe.xyz'],
		proxy: {
			'/canvas/api/rooms': { target: api, ws: true },
			'/canvas/api/live': { target: api, ws: true },
			'/canvas/api': api,
			'/canvas/media': api,
		},
	},
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		rollupOptions: {
			input: {
				main: resolve(__dirname, 'index.html'),
				playground: resolve(__dirname, 'playground/index.html'),
				'playground-busy': resolve(__dirname, 'playground/busy.html'),
				'playground-subagents': resolve(__dirname, 'playground/subagents.html'),
			},
		},
	},
})
