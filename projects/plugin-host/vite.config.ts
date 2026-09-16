import { runtime } from '@pluxel/runtime/vite'
import { defineConfig } from 'vite'
import { hostEnv } from '@pluxel/runtime/environment'

export default defineConfig({
	appType: 'spa',
	ssr: {
		// This package publishes extensionless ESM imports that need Vite resolution.
		noExternal: ['@opentelemetry/resources'],
	},
	server: {
		host: hostEnv.hostBind ?? '127.0.0.1',
		port: hostEnv.hostPort ?? 3310,
	},
	plugins: [runtime({ entry: './src/app.ts', devConsole: true })],
})
