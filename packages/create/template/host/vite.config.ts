import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type UserConfig } from 'vite'

const webRoot = fileURLToPath(new URL('./web', import.meta.url))
const webEntry = fileURLToPath(new URL('./web/index.html', import.meta.url))
const staticEntry = fileURLToPath(new URL('./src/pluxel.static.ts', import.meta.url))
const dynamicConfig = fileURLToPath(new URL('./src/pluxel.dynamic.ts', import.meta.url))

export default defineConfig(async ({ mode }): Promise<UserConfig> => {
	const runtime =
		mode === 'dynamic'
			? (await import('@pluxel/runtime-dynamic/vite')).dynamicRuntimeVitePlugin({
					config: dynamicConfig,
				})
			: (await import('@pluxel/runtime-static/vite')).staticRuntimeVitePlugin({
					entry: staticEntry,
				})

	return {
		root: webRoot,
		appType: 'spa',
		server: {
			host: process.env.PLUXEL_HOST_BIND ?? '127.0.0.1',
			port: Number(process.env.PLUXEL_HOST_PORT ?? 3310),
		},
		build: {
			outDir: 'dist',
			emptyOutDir: true,
			manifest: true,
		},
		optimizeDeps: {
			entries: [webEntry],
		},
		plugins: [react(), ...runtime],
	}
})
