// Vite loads this config before Pluxel source conditions are active, so use the
// workspace source here to avoid running stale runtime-static dist output.
import { staticRuntimeVitePlugin } from '../../packages/runtime-static/src/vite.ts'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
	appType: 'spa',
	server: {
		host: process.env.PLUXEL_HOST_BIND ?? '127.0.0.1',
		port: Number(process.env.PLUXEL_HOST_PORT ?? 3313),
	},
	plugins: [
		staticRuntimeVitePlugin({
			entry: './src/pluxel.static.ts',
		}),
		react(),
	],
})
