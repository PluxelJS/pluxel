// Vite loads this config before Pluxel source conditions are active, so use the
// workspace source here to avoid running stale runtime-dynamic dist output.
import { dynamicRuntimeVitePlugin } from '../../packages/runtime-dynamic/src/vite.ts'
import { defineConfig } from 'vite'

export default defineConfig({
	appType: 'spa',
	ssr: {
		// @opentelemetry/resources publishes extensionless ESM imports that Node cannot
		// execute directly. Keep it in Vite's SSR graph for the dynamic OtelPlugin demo.
		noExternal: ['@opentelemetry/resources'],
	},
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
