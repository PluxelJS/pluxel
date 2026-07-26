// Vite loads its config before workspace source conditions are active.
import { staticRuntimeVitePlugin } from '../../packages/runtime-static/src/vite.ts'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
	appType: 'spa',
	server: {
		host: process.env.PLUXEL_HOST_BIND ?? '127.0.0.1',
		port: Number(process.env.PLUXEL_HOST_PORT ?? 3314),
	},
	build: {
		outDir: 'dist/public',
		emptyOutDir: false,
		manifest: true,
		chunkSizeWarningLimit: 700,
	},
	plugins: [
		staticRuntimeVitePlugin({
			entry: './src/pluxel.static.ts',
		}),
		react(),
	],
})
