import { createServer as createNetServer } from 'node:net'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { join } from 'pathe'
import { createServer, mergeConfig, normalizePath, type Plugin as VitePlugin } from 'vite'
import { describe, expect, it } from 'vitest'
import { createHmrTestHost, type ErrorLog } from './_host'
import { buildLoaderHmrViteConfig, resolveFsAllowList } from '../../src/hmr/engine/config'
import { LoaderHmrService } from '../../src/hmr/engine/LoaderHmrService'

async function getFreePort(host = '127.0.0.1'): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createNetServer()
		server.unref()
		server.on('error', reject)
		server.listen(0, host, () => {
			const address = server.address()
			if (!address || typeof address === 'string') {
				server.close(() => reject(new Error('Failed to allocate a TCP port')))
				return
			}
			const port = address.port
			server.close(() => resolve(port))
		})
	})
}

async function runHmr(root: string, hmr: LoaderHmrService) {
	const fsAllow = resolveFsAllowList({
		cwd: root,
		cwdNormalized: normalizePath(root),
		scanRoots: [normalizePath(root)],
	})

	const hmrPort = await getFreePort()
	const serverConfig = mergeConfig(
		buildLoaderHmrViteConfig({
			root,
			fsAllow,
			runnerPlugin: (hmr as unknown as { plugin: VitePlugin }).plugin,
			httpPlugin: { name: 'noop' },
			port: 0,
		}),
		// Tests use the SSR module runner only; avoid flakiness from Vite's default WebSocket port.
		// Vite can still attempt to spin up the ws server in middleware mode, so we always
		// allocate a unique free port to prevent cross-test / local dev conflicts.
		{ server: { middlewareMode: true, ws: { port: hmrPort }, fs: { allow: fsAllow } } },
	)
	// The module runner triggers imports explicitly. Assign after mergeConfig because null overrides are ignored.
	serverConfig.server = { ...serverConfig.server, watch: null }
	const server = await createServer(serverConfig)
	expect(server.config.server.watch).toBeNull()

	try {
		await hmr.executeFiles([join(root, 'entry.ts')])
	} finally {
		await server.close()
	}
}

async function executeHmr(root: string) {
	const errorLogs: ErrorLog[] = []
	const host = createHmrTestHost({ errorLogs })
	const hmr = new LoaderHmrService(host.ctx, { roots: [root], entries: [], report: false })
	hmr.setServerRoot(root)
	try {
		await runHmr(root, hmr)
	} finally {
		await host.dispose()
	}
	return errorLogs.find((entry) => entry.msg === '[HMR] execute failed')
}

describe('HMR CJS dependency handling', () => {
	it('externalizes CJS deps so require() works', async () => {
		await using fixture = await createFixture({
			'node_modules/cjs-pkg/package.json': JSON.stringify(
				{ name: 'cjs-pkg', version: '1.0.0', main: 'index.js' },
				null,
				2,
			),
			'node_modules/cjs-pkg/index.js':
				"const { platform } = require('os'); module.exports = { platform };\n",
			'entry.ts': "import pkg from 'cjs-pkg'; export const platform = pkg.platform;\n",
		})
		const root = fixture.path
		await expect(executeHmr(root)).resolves.toBeUndefined()
	}, 15_000)

	it('auto-externalizes CJS files resolved through workspace aliases', async () => {
		await using fixture = await createFixture({
			// Force a bare specifier to resolve into workspace source (not node_modules),
			// so Vite's runner inlines the CJS file and triggers "require is not defined".
			'tsconfig.json': JSON.stringify(
				{
					include: ['**/*'],
					compilerOptions: {
						baseUrl: '.',
						paths: {
							'cjs-pkg': ['./cjs-pkg/index.cjs'],
						},
					},
				},
				null,
				2,
			),
			'cjs-pkg/package.json': JSON.stringify({ name: 'cjs-pkg', version: '1.0.0' }, null, 2),
			'cjs-pkg/index.cjs': "const { platform } = require('os'); module.exports = { platform };\n",
			'entry.ts': "import pkg from 'cjs-pkg'; export const platform = pkg.platform;\n",
		})
		const root = fixture.path
		await expect(executeHmr(root)).resolves.toBeUndefined()
	})
})
