import { describe, expect, it } from 'vitest'
import { join } from 'pathe'
import { rmSync, symlinkSync } from 'node:fs'
import { createServer, normalizePath, type Plugin as VitePlugin } from 'vite'
import {
	captureLoaderModules,
	createHmrTestHost,
	type ErrorLog,
	type LoaderModuleCapture,
} from './_host'
import { fixturesPluginsDir, fixturesPluginsRelFromWorkspace, workspaceRoot } from './_paths'
import {
	buildHmrViteConfig,
	type HMRDependencyConfig,
	resolveFsAllowList,
	resolveHMRDependencyConfig,
	HMRService,
} from '@pluxel/hmr'

const baseDeps: HMRDependencyConfig = {
	bridgeModules: [],
	ssrExternal: [],
	ssrNoExternal: [],
	optimizeDepsInclude: [],
	optimizeDepsInterop: [],
	cjsExternal: [],
}

type CoreApi = {
	getConfigSource: (ctor: unknown) => Record<string, unknown> | null
	getRequiredPluginDependencies: (ctor: unknown) => unknown[]
	getUsedFeatures: (ctor: unknown) => Array<{ name: string }>
}

async function withPluginRunner<T>(
	run: (
		execute: (pluginEntry: string) => Promise<{
			capture: LoaderModuleCapture
			errorLogs: ErrorLog[]
			core: CoreApi
		}>,
	) => Promise<T>,
	opts?: {
		rootsRelFromWorkspace?: string
		scanRootsAbs?: string[]
		include?: string[]
		exclude?: string[]
	},
): Promise<T> {
	const root = workspaceRoot
	const capture = { lastModule: null as unknown, beginBatchCalls: 0, replaceModuleCalls: 0 }
	const errorLogs: ErrorLog[] = []
	const host = createHmrTestHost({ errorLogs })
	captureLoaderModules(host, capture)
	const deps = resolveHMRDependencyConfig(baseDeps)
	const rootsRel = opts?.rootsRelFromWorkspace ?? fixturesPluginsRelFromWorkspace
	const scanRootsAbs = opts?.scanRootsAbs ?? [normalizePath(fixturesPluginsDir)]
	const fsAllow = resolveFsAllowList({
		cwd: root,
		cwdNormalized: normalizePath(root),
		scanRoots: scanRootsAbs,
	})

	const hmr = new HMRService(host.ctx, {
		roots: [rootsRel],
		entries: [],
		report: false,
		deps: baseDeps,
		include: opts?.include,
		exclude: opts?.exclude,
	})
	hmr.setServerRoot(root)
	const runnerPlugin = (hmr as unknown as { plugin: VitePlugin }).plugin

	const server = await createServer({
		...buildHmrViteConfig({
			root,
			fsAllow,
			deps,
			runnerPlugin,
			httpPlugin: { name: 'noop' },
			port: 0,
		}),
		server: { middlewareMode: true, fs: { allow: fsAllow }, hmr: false, ws: false },
	})

	try {
		return await run(async (pluginEntry) => {
			capture.lastModule = null
			capture.beginBatchCalls = 0
			capture.replaceModuleCalls = 0
			errorLogs.length = 0
			await hmr.executeFiles([pluginEntry])
			const core = (await (hmr as any).runner.import('@pluxel/core')) as CoreApi
			return { capture, errorLogs, core }
		})
	} finally {
		await server.close()
		await host.dispose()
	}
}

describe('configSourcePlugin integration', () => {
	it('extracts config and feature metadata for fixture entries', async () => {
		const root = workspaceRoot
		await withPluginRunner(async (execute) => {
			{
				const pluginEntry = join(root, fixturesPluginsRelFromWorkspace, 'PluginB.ts')
				const { capture, errorLogs, core } = await execute(pluginEntry)

				expect(errorLogs).toEqual([])
				expect(capture.lastModule).toBeTruthy()
				const ctor = (capture.lastModule as { PluginB?: unknown } | null)?.PluginB
				expect(typeof ctor).toBe('function')
				const map = core.getConfigSource(ctor)
				expect(map).toBeTruthy()
				expect(Object.keys(map ?? {})).toContain('a')
				expect(Object.keys(map ?? {})).toContain('ba')
			}

			{
				const pluginEntry = join(root, fixturesPluginsRelFromWorkspace, 'PluginConfigUse.ts')
				const { capture, errorLogs, core } = await execute(pluginEntry)

				expect(errorLogs).toEqual([])
				expect(capture.lastModule).toBeTruthy()
				const ctor = (capture.lastModule as { PluginConfigUse?: unknown } | null)?.PluginConfigUse
				expect(typeof ctor).toBe('function')
				const map = core.getConfigSource(ctor)
				expect(map).toBeTruthy()
				expect(Object.keys(map ?? {})).toContain('foo')
			}

			{
				const pluginEntry = join(root, fixturesPluginsRelFromWorkspace, 'PluginFeatureUse.ts')
				const { capture, errorLogs, core } = await execute(pluginEntry)

				expect(errorLogs).toEqual([])
				expect(capture.lastModule).toBeTruthy()
				const ctor = (capture.lastModule as { PluginFeatureUse?: unknown } | null)?.PluginFeatureUse
				expect(typeof ctor).toBe('function')
				const kv = (capture.lastModule as { KvPlugin?: unknown } | null)?.KvPlugin
				expect(typeof kv).toBe('function')
				expect(core.getRequiredPluginDependencies(ctor)).toContain(kv)
				expect(core.getUsedFeatures(ctor).map((x) => x.name)).toContain('CacheFeature')
			}
		})
	}, 20_000)

	it('supports configs.use(schema) when scanRoot is a symlink (realpath module ids)', async () => {
		const root = workspaceRoot
		// Keep the symlinked root under `packages/runtime/**` so Vite picks up the package tsconfig
		// (decorators transform). Otherwise the file may execute as raw TS and crash with a SyntaxError.
		const rootsRel = 'packages/runtime/.tmp-pluxel-configSource-symlink'
		const linkAbs = join(root, rootsRel)
		rmSync(linkAbs, { recursive: true, force: true })
		symlinkSync(fixturesPluginsDir, linkAbs, 'dir')

		try {
			const pluginEntry = join(root, rootsRel, 'PluginConfigUse.ts')
			await withPluginRunner(
				async (execute) => {
					const { capture, errorLogs, core } = await execute(pluginEntry)

					expect(errorLogs).toEqual([])
					expect(capture.lastModule).toBeTruthy()
					const ctor = (capture.lastModule as { PluginConfigUse?: unknown } | null)?.PluginConfigUse
					expect(typeof ctor).toBe('function')
					const map = core.getConfigSource(ctor)
					expect(map).toBeTruthy()
					expect(Object.keys(map ?? {})).toContain('foo')
				},
				{
					rootsRelFromWorkspace: rootsRel,
					scanRootsAbs: [normalizePath(linkAbs)],
				},
			)
		} finally {
			rmSync(linkAbs, { recursive: true, force: true })
		}
	}, 20_000)
})
