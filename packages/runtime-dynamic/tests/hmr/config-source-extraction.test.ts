import { describe, expect, it } from 'vitest'
import { join } from 'pathe'
import { rmSync, symlinkSync } from 'node:fs'
import { createServer, mergeConfig, normalizePath, type Plugin as VitePlugin } from 'vite'
import {
	captureLoaderModules,
	createHmrTestHost,
	type ErrorLog,
	type LoaderModuleCapture,
} from './_host'
import { fixturesPluginsDir, fixturesPluginsRelFromWorkspace, workspaceRoot } from './_paths'
import { buildLoaderHmrViteConfig, resolveFsAllowList } from '../../src/hmr/engine/config'
import { LoaderHmrService } from '../../src/hmr/engine/LoaderHmrService'

type CoreApi = {
	getPluginInfo: (ctor: unknown) => {
		config?: { fieldName: string; source?: string }
	}
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
	const rootsRel = opts?.rootsRelFromWorkspace ?? fixturesPluginsRelFromWorkspace
	const scanRootsAbs = opts?.scanRootsAbs ?? [normalizePath(fixturesPluginsDir)]
	const fsAllow = resolveFsAllowList({
		cwd: root,
		cwdNormalized: normalizePath(root),
		scanRoots: scanRootsAbs,
	})

	const hmr = new LoaderHmrService(host.ctx, {
		roots: [rootsRel],
		entries: [],
		report: false,
		include: opts?.include,
		exclude: opts?.exclude,
	})
	hmr.setServerRoot(root)
	const runnerPlugin = (hmr as unknown as { plugin: VitePlugin }).plugin

	const serverConfig = mergeConfig(
		buildLoaderHmrViteConfig({
			viteRoot: root,
			sourceRoot: root,
			fsAllow,
			runnerPlugin,
			httpPlugin: { name: 'noop' },
			port: 0,
		}),
		{ server: { middlewareMode: true, fs: { allow: fsAllow }, hmr: false, ws: false } },
	)
	// Vite's mergeConfig intentionally ignores null overrides. Assign after merging because this test
	// drives the module runner explicitly and must not recursively watch the workspace root.
	serverConfig.server = { ...serverConfig.server, watch: null }
	const server = await createServer(serverConfig)
	expect(server.config.server.watch).toBeNull()

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
	it('extracts one object config definition for fixture entries', async () => {
		const root = workspaceRoot
		await withPluginRunner(async (execute) => {
			{
				const pluginEntry = join(root, fixturesPluginsRelFromWorkspace, 'PluginB.ts')
				const { capture, errorLogs, core } = await execute(pluginEntry)

				expect(errorLogs).toEqual([])
				expect(capture.lastModule).toBeTruthy()
				const ctor = (capture.lastModule as { PluginB?: unknown } | null)?.PluginB
				expect(typeof ctor).toBe('function')
				const config = core.getPluginInfo(ctor).config
				expect(config?.fieldName).toBe('config')
				expect(config?.source).toContain('a:')
				expect(config?.source).toContain('ba:')
			}

			{
				const pluginEntry = join(root, fixturesPluginsRelFromWorkspace, 'PluginConfigUse.ts')
				const { capture, errorLogs, core } = await execute(pluginEntry)

				expect(errorLogs).toEqual([])
				expect(capture.lastModule).toBeTruthy()
				const ctor = (capture.lastModule as { PluginConfigUse?: unknown } | null)?.PluginConfigUse
				expect(typeof ctor).toBe('function')
				const config = core.getPluginInfo(ctor).config
				expect(config?.fieldName).toBe('foo')
				expect(config?.source).toContain('enabled:')
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
					const config = core.getPluginInfo(ctor).config
					expect(config?.fieldName).toBe('foo')
					expect(config?.source).toContain('enabled:')
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
