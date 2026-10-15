import packConfig from './tsdown.config'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, lazyPlugins } from 'vite-plus'
import { vitePreset } from '@pluxel/services/vite'
import { hostEnv } from '@pluxel/host/environment'

const webRoot = fileURLToPath(new URL('./web', import.meta.url))
const webEntry = fileURLToPath(new URL('./web/index.html', import.meta.url))
const entry = fileURLToPath(new URL('./src/app.ts', import.meta.url))

import { buildTask, checkCache } from '../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: {
			'check-types': { command: 'tsc --noEmit --pretty false', cache: checkCache },
			compile: buildTask(
				'vp build --config vite.config.ts && vp pack && pluxel distribution create ./dist',
			),
		},
	},

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
	plugins: lazyPlugins(() => [react(), vitePreset({ entry, devConsole: true })]),
})
