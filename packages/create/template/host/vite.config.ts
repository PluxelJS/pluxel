import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type UserConfig } from 'vite'
import { hostEnv } from '@pluxel/runtime/environment'

const webRoot = fileURLToPath(new URL('./web', import.meta.url))
const webEntry = fileURLToPath(new URL('./web/index.html', import.meta.url))
const staticEntry = fileURLToPath(new URL('./src/pluxel.static.ts', import.meta.url))
const dynamicEntry = fileURLToPath(new URL('./src/pluxel.dynamic.ts', import.meta.url))

export default defineConfig(async ({ mode }): Promise<UserConfig> => {
	let plugins: UserConfig['plugins']
	if (mode === 'dynamic') {
		const { dynamicRuntimeVitePlugin } = await import('@pluxel/runtime-dynamic/vite')
		plugins = dynamicRuntimeVitePlugin({ entry: dynamicEntry })
	} else {
		const { staticRuntimeVitePlugin } = await import('@pluxel/runtime-static/vite')
		plugins = [react(), ...staticRuntimeVitePlugin({ entry: staticEntry })]
	}

	return {
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
		plugins,
	}
})
