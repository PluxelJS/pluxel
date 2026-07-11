// Vite loads its config before workspace source conditions are active.
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
			config: './src/pluxel.static.ts',
		}),
	],
})
