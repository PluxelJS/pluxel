import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { hostEnv } from '@pluxel/host/environment'
import { consumerCompiler } from './server.ts'

export default defineConfig({
	root: import.meta.dirname,
	// The playground and package Vitest process must not replace each other's optimized deps.
	cacheDir: resolve(import.meta.dirname, '../../node_modules/.vite/consumer'),
	plugins: [consumerCompiler()],
	server: {
		host: '127.0.0.1',
		port: hostEnv.hostPort ?? 3410,
		strictPort: true,
		cors: false,
		allowedHosts: hostEnv.publicOrigin ? [new URL(hostEnv.publicOrigin).hostname] : [],
	},
})
