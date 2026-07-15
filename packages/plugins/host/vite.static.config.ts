// Load the workspace source so plugin-host reflects runtime-static changes before a package build.
import { staticRuntimeVitePlugin } from '../../runtime-static/src/vite.ts'
import { defineConfig } from 'vite'

export default defineConfig({
	appType: 'spa',
	server: {
		host: process.env.PLUXEL_HOST_BIND ?? '127.0.0.1',
		port: Number(process.env.PLUXEL_HOST_PORT ?? 3310),
	},
	plugins: [
		staticRuntimeVitePlugin({
			entry: './src/pluxel.static.ts',
		}),
	],
})
