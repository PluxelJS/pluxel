import { describe, expect, it } from 'vitest'
import type { Context } from '@pluxel/core'
import { createFixture } from 'fs-fixture'
import { join } from 'pathe'
import { createServer, normalizePath, type Plugin as VitePlugin } from 'vite'
import {
	buildHmrViteConfig,
	resolveFsAllowList,
	resolveHMRDependencyConfig,
} from '../../src/services/runtime/hmr/config'
import { HMRService } from '../../src/services/runtime/hmr/HMRService'

const baseDeps = {
	bridgeModules: [],
	ssrExternal: [],
	ssrNoExternal: [],
	optimizeDepsInclude: [],
	optimizeDepsInterop: [],
}

type ErrorLog = { msg: string; obj: unknown }

function buildDeps(cjsExternal: string[]) {
	return { ...baseDeps, cjsExternal }
}

function createContext(errorLogs?: ErrorLog[], scanService?: unknown) {
	const anchors = new Set<string>()
	return {
		logger: {
			info: () => undefined,
			warn: () => undefined,
			error(obj: unknown, msg: string) {
				if (errorLogs) errorLogs.push({ msg, obj })
			},
		},
		scanService: scanService ?? { resolveEntry: async () => ({ ok: false }) },
		loader: {
			api: {
				anchors: {
					list: () => anchors,
					remove: (id: string) => anchors.delete(id),
				},
			},
			beginBatch() {
				return {
					replaceModule: async () => false,
					rollback: () => undefined,
					commit: () => undefined,
				}
			},
			pruneModule: () => undefined,
		},
		registry: {
			commit: async () => ({ ok: true }),
			resetDraft: () => undefined,
			container: { services: new Map() },
		},
		honoService: {
			viteHonoDevServer: { name: 'noop', apply: 'serve', configureServer: () => undefined },
		},
	} as unknown as Context
}

async function runHmr(root: string, hmr: HMRService, depsInput: ReturnType<typeof buildDeps>) {
	const deps = resolveHMRDependencyConfig(depsInput)
	const fsAllow = resolveFsAllowList({
		cwd: root,
		cwdNormalized: normalizePath(root),
		scanRoots: [normalizePath(root)],
	})

	const server = await createServer({
		...buildHmrViteConfig({
			root,
			fsAllow,
			scanRoots: [root],
			deps,
			runnerPlugin: (hmr as unknown as { plugin: VitePlugin }).plugin,
			honoPlugin: { name: 'noop' },
			port: 0,
		}),
		server: { middlewareMode: true, fs: { allow: fsAllow } },
	})

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
		const hmr = new HMRService(createContext(errorLogs), {
			roots: [root],
			entries: [],
			deps: depsInput,
		})
		hmr.setServerRoot(root)

		await runHmr(root, hmr, depsInput)

		const executeFailed = errorLogs.find((e) => e.msg === '[HMR] execute failed')
		expect(executeFailed).toBeUndefined()
	})

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
		const hmr = new HMRService(createContext(errorLogs), {
			roots: [root],
			entries: [],
			deps: depsInput,
		})
		hmr.setServerRoot(root)

		await runHmr(root, hmr, depsInput)

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
		const ctx = createContext(errorLogs, {
			resolveEntry: async ({ name }: { name: string }) => {
				if (name !== 'cjs-pkg') return { ok: false }
				return { ok: true, entry: join(root, 'cjs-pkg', 'index.cjs') }
			},
		})
		const hmr = new HMRService(ctx, {
			roots: [root],
			entries: [],
			deps: depsInput,
		})
		hmr.setServerRoot(root)

		await runHmr(root, hmr, depsInput)

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
		const hmr = new HMRService(createContext(), {
			roots: [root],
			entries: [],
			deps: depsInput,
		})
		hmr.setServerRoot(root)

		let thrown: unknown = null
		try {
			await runHmr(root, hmr, depsInput)
		} catch (e) {
			thrown = e
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
		const hmr = new HMRService(createContext(errorLogs), {
			roots: [root],
			entries: [],
			deps: depsInput,
		})
		hmr.setServerRoot(root)

		await runHmr(root, hmr, depsInput)

		const executeFailed = errorLogs.find((e) => e.msg === '[HMR] execute failed')
		expect(executeFailed).toBeUndefined()
	})
})
