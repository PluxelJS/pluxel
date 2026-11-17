import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { resolveHostEnv } from '@pluxel/host/environment'
import { consumerCompiler } from './server.ts'

export default defineConfig(() => {
	const environment = resolveHostEnv({ ...process.env })
	return {
		root: import.meta.dirname,
		// The playground and package Vitest process must not replace each other's optimized deps.
		cacheDir: resolve(import.meta.dirname, '../../node_modules/.vite/consumer'),
		plugins: [consumerCompiler({ publicOrigin: environment.publicOrigin })],
		server: {
			host: '127.0.0.1',
			port: environment.hostPort ?? 3410,
			strictPort: true,
			cors: false,
			fs: {
				deny: [
					'.env',
					'.env.*',
					'*.{crt,pem,key,p12,pfx,cer,der}',
					'.npmrc',
					'.yarnrc.yml',
					'**/.git/**',
					'**/document-private/**',
					'**/private-proposal/**',
					'**/consumer/server.ts',
					'**/consumer/vite.config.ts',
				],
			},
			allowedHosts: environment.publicOrigin ? [new URL(environment.publicOrigin).hostname] : [],
		},
	}
})
