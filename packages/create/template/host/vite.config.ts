import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { vitePreset } from '@pluxel/services/vite'
import { hostEnv } from '@pluxel/runtime/environment'

const webRoot = fileURLToPath(new URL('./web', import.meta.url))
const webEntry = fileURLToPath(new URL('./web/index.html', import.meta.url))
const entry = fileURLToPath(new URL('./src/app.ts', import.meta.url))

export default defineConfig({
	root: webRoot,
	appType: 'spa',
	server: {
		host: hostEnv.hostBind ?? '127.0.0.1',
		port: hostEnv.hostPort,
		strictPort: hostEnv.hostPort !== undefined,
	},
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		manifest: true,
	},
	optimizeDeps: {
		entries: [webEntry],
	},
	plugins: [react(), vitePreset({ entry, devConsole: true })],
})
