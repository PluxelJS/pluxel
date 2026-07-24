import { createServer as createNetServer } from 'node:net'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { join } from 'pathe'
import { createServer, mergeConfig, normalizePath, type Plugin as VitePlugin } from 'vite'
import { describe, expect, it } from 'vitest'
import { createHmrTestHost, type ErrorLog } from './_host'
import {
	buildLoaderHmrViteConfig,
	resolveFsAllowList,
	resolveLoaderHmrDependencyConfig,
} from '../../src/hmr/engine/config'
import { LoaderHmrService } from '../../src/hmr/engine/LoaderHmrService'

const baseDeps = {
	bridgeModules: [],
	ssrExternal: [],
	ssrNoExternal: [],
	optimizeDepsInclude: [],
	optimizeDepsInterop: [],
}

function buildDeps(cjsExternal: string[]) {
	return { ...baseDeps, cjsExternal }
}

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

async function runHmr(
	root: string,
	hmr: LoaderHmrService,
	depsInput: ReturnType<typeof buildDeps>,
) {
	const deps = resolveLoaderHmrDependencyConfig(depsInput)
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
			deps,
			runnerPlugin: (hmr as unknown as { plugin: VitePlugin }).plugin,
			httpPlugin: { name: 'noop' },
			port: 0,
		}),
		// Tests use the SSR module runner only; avoid flakiness from Vite's default HMR ws port (24678).
		// Some Vite versions still attempt to spin up the ws server even in middleware mode, so we always
		// allocate a unique free port to prevent cross-test / local dev conflicts.
		{ server: { middlewareMode: true, hmr: { port: hmrPort }, fs: { allow: fsAllow } } },
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
		const errorLogs: ErrorLog[] = []
		const depsInput = buildDeps(['cjs-pkg'])
		const host = createHmrTestHost({ errorLogs })
		const hmr = new LoaderHmrService(host.ctx, {
			roots: [root],
			entries: [],
			report: false,
			deps: depsInput,
		})
		hmr.setServerRoot(root)

		try {
			await runHmr(root, hmr, depsInput)
		} finally {
			await host.dispose()
		}

		const executeFailed = errorLogs.find((e) => e.msg === '[HMR] execute failed')
		expect(executeFailed).toBeUndefined()
	}, 15_000)

	it('externalizes CJS subpath exports (pkg/subpath)', async () => {
		await using fixture = await createFixture({
			'node_modules/pluxel-plugin-napi-rs/package.json': JSON.stringify(
				{
					name: 'pluxel-plugin-napi-rs',
					version: '1.0.0',
					exports: {
						'./canvas': './canvas/index.cjs',
					},
				},
				null,
				2,
			),
			'node_modules/pluxel-plugin-napi-rs/canvas/index.cjs':
				"const { platform } = require('os'); module.exports = { platform };\n",
			'entry.ts':
				"import pkg from 'pluxel-plugin-napi-rs/canvas'; export const platform = pkg.platform;\n",
		})
		const root = fixture.path
		const errorLogs: ErrorLog[] = []
		const depsInput = buildDeps(['pluxel-plugin-napi-rs/*'])
		const host = createHmrTestHost({ errorLogs })
		const hmr = new LoaderHmrService(host.ctx, {
			roots: [root],
			entries: [],
			report: false,
			deps: depsInput,
		})
		hmr.setServerRoot(root)

		try {
			await runHmr(root, hmr, depsInput)
		} finally {
			await host.dispose()
		}

		const executeFailed = errorLogs.find((e) => e.msg === '[HMR] execute failed')
		expect(executeFailed).toBeUndefined()
	})

	it('externalizes CJS deps before workspace resolver', async () => {
		await using fixture = await createFixture({
			// A node_modules CJS package that will work when externalized.
			'node_modules/cjs-pkg/package.json': JSON.stringify(
				{ name: 'cjs-pkg', version: '1.0.0', main: 'index.js' },
				null,
				2,
			),
			'node_modules/cjs-pkg/index.js':
				"const { platform } = require('os'); module.exports = { platform };\n",
			// A workspace-scanned entry that points to a CJS file (this is what used to preempt externalization).
			'cjs-pkg/package.json': JSON.stringify({ name: 'cjs-pkg', version: '1.0.0' }, null, 2),
			'cjs-pkg/index.cjs': "const { platform } = require('os'); module.exports = { platform };\n",
			'entry.ts': "import pkg from 'cjs-pkg'; export const platform = pkg.platform;\n",
		})
		const root = fixture.path
		const errorLogs: ErrorLog[] = []
		const depsInput = buildDeps(['cjs-pkg'])
		const host = createHmrTestHost({
			errorLogs,
			scanService: {
				resolveEntry: async ({ name }: { name: string }) => {
					if (name !== 'cjs-pkg') return { ok: false }
					return { ok: true, entry: join(root, 'cjs-pkg', 'index.cjs') }
				},
			},
		})
		const hmr = new LoaderHmrService(host.ctx, {
			roots: [root],
			entries: [],
			report: false,
			deps: depsInput,
		})
		hmr.setServerRoot(root)

		try {
			await runHmr(root, hmr, depsInput)
		} finally {
			await host.dispose()
		}

		const executeFailed = errorLogs.find((e) => e.msg === '[HMR] execute failed')
		expect(executeFailed).toBeUndefined()
	})

	it('fails fast with a helpful hint for unmarked CJS deps', async () => {
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
		const depsInput = buildDeps([])
		const host = createHmrTestHost()
		const hmr = new LoaderHmrService(host.ctx, {
			roots: [root],
			entries: [],
			report: false,
			deps: depsInput,
		})
		hmr.setServerRoot(root)

		let thrown: unknown = null
		try {
			await runHmr(root, hmr, depsInput)
		} catch (e) {
			thrown = e
		} finally {
			await host.dispose()
		}

		expect(thrown).toBeTruthy()
		expect(String(thrown?.message ?? '')).toContain('cjs-pkg')
		expect(String(thrown?.message ?? '')).not.toContain('rolldown-vite')
	})

	it('externalizes marked CJS deps even when resolved to /@fs/ file URLs', async () => {
		await using fixture = await createFixture({
			// Force a bare specifier to resolve into a local .cjs file via tsconfig paths.
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
		const errorLogs: ErrorLog[] = []
		const depsInput = buildDeps(['cjs-pkg'])
		const host = createHmrTestHost({ errorLogs })
		const hmr = new LoaderHmrService(host.ctx, {
			roots: [root],
			entries: [],
			report: false,
			deps: depsInput,
		})
		hmr.setServerRoot(root)

		try {
			await runHmr(root, hmr, depsInput)
		} finally {
			await host.dispose()
		}

		const executeFailed = errorLogs.find((e) => e.msg === '[HMR] execute failed')
		expect(executeFailed).toBeUndefined()
	})
})
