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
		proxy: { '/api': api, '/media': api },
	},
	build: { outDir: 'dist', emptyOutDir: true },
})
