import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const api = `http://localhost:${process.env.PORT ?? 4410}`

export default defineConfig({
	root: __dirname,
	plugins: [react()],
	server: {
		port: 5173,
		host: true,
		allowedHosts: ['jamesbox.exe.xyz', '.exe.xyz'],
		proxy: { '/api/rooms': { target: api, ws: true }, '/api': api, '/media': api, '/shares': api },
	},
	build: { outDir: 'dist', emptyOutDir: true },
})
