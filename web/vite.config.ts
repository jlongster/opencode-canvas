import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
			'/canvas/api': api,
			'/canvas/media': api,
			'/canvas/shares': api,
		},
	},
	build: { outDir: 'dist', emptyOutDir: true },
})
