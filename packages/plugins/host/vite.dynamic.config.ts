// Vite loads this config before Pluxel source conditions are active, so use the
// workspace source here to avoid running stale runtime-dynamic dist output.
import { dynamicRuntimeVitePlugin } from '../../runtime-dynamic/src/vite.ts'
import { defineConfig } from 'vite'

export default defineConfig({
	appType: 'spa',
	server: {
		host: process.env.PLUXEL_HOST_BIND ?? '127.0.0.1',
		port: Number(process.env.PLUXEL_HOST_PORT ?? 5173),
	},
	plugins: [
		dynamicRuntimeVitePlugin({
			config: './src/pluxel.dynamic.ts',
		}),
	],
})
