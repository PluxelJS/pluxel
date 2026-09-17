import { host } from '@pluxel/host-dev/vite'
import { nodeArtifacts } from '@pluxel/host-dev/node'
import { httpDevelopment } from '@pluxel/host-dev/http'
import { workbenchArtifacts } from '@pluxel/workbench/dev'
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
	plugins: [
		host({ entry: './src/app.ts', devConsole: true }),
		nodeArtifacts(),
		process.env.PLUXEL_WORKBENCH !== 'false' ? workbenchArtifacts() : undefined,
		httpDevelopment(),
	],
})
