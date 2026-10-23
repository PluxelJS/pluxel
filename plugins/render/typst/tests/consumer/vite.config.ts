import { defineConfig } from 'vite'
import { hostEnv } from '@pluxel/host/environment'
import { consumerCompiler } from './server.ts'

export default defineConfig({
	root: import.meta.dirname,
	plugins: [consumerCompiler()],
	server: {
		host: '127.0.0.1',
		port: hostEnv.hostPort ?? 3410,
		strictPort: true,
		cors: false,
		allowedHosts: hostEnv.publicOrigin ? [new URL(hostEnv.publicOrigin).hostname] : [],
	},
})
