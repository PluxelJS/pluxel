// Load the workspace source so plugin-host reflects runtime-static changes before a package build.
import { staticRuntimeVitePlugin } from '../../packages/runtime-static/src/vite.ts'
import { defineConfig } from 'vite'
import { hostEnv } from '@pluxel/runtime/environment'

export default defineConfig({
	appType: 'spa',
	server: {
		host: hostEnv.hostBind ?? '127.0.0.1',
		port: hostEnv.hostPort ?? 3310,
	},
	plugins: [
		staticRuntimeVitePlugin({
			entry: './src/pluxel.static.ts',
			devConsole: true,
		}),
	],
})
