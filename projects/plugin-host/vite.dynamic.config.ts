// Vite loads this config before Pluxel source conditions are active, so use the
// workspace source here to avoid running stale runtime-dynamic dist output.
import { dynamicRuntimeVitePlugin } from '../../packages/runtime-dynamic/src/vite.ts'
import { defineConfig } from 'vite'
import { hostEnv } from '@pluxel/runtime/environment'

export default defineConfig({
	appType: 'spa',
	ssr: {
		// @opentelemetry/resources publishes extensionless ESM imports that Node cannot
		// execute directly. Keep it in Vite's SSR graph for the dynamic OtelPlugin demo.
		noExternal: ['@opentelemetry/resources'],
	},
	server: {
		host: hostEnv.hostBind ?? '127.0.0.1',
		port: hostEnv.hostPort ?? 5173,
	},
	plugins: [
		dynamicRuntimeVitePlugin({
			entry: './src/pluxel.dynamic.ts',
			devConsole: true,
		}),
	],
})
