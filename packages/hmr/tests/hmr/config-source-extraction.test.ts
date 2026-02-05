import { describe, expect, it } from 'vitest'
import type { Context } from '@pluxel/core'
import { join } from 'pathe'
import { createServer, normalizePath, type Plugin as VitePlugin } from 'vite'
import { fixturesPluginsDir, fixturesPluginsRelFromWorkspace, workspaceRoot } from './_paths'
import {
	buildHmrViteConfig,
	type HMRDependencyConfig,
	resolveFsAllowList,
	resolveHMRDependencyConfig,
} from '../../src/services/runtime/hmr/config'
import { HMRService } from '../../src/services/runtime/hmr/HMRService'

const baseDeps: HMRDependencyConfig = {
	bridgeModules: [],
	ssrExternal: [],
	ssrNoExternal: [],
	optimizeDepsInclude: [],
	optimizeDepsInterop: [],
	cjsExternal: [],
}

type ErrorLog = { msg: string; obj: unknown }
type CoreApi = {
	getConfigSource: (ctor: unknown) => Record<string, unknown> | null
	getRequiredPluginDependencies: (ctor: unknown) => unknown[]
	getUsedFeatures: (ctor: unknown) => Array<{ name: string }>
}

async function executePluginEntryAndCapture(
	pluginEntry: string,
): Promise<{ capture: { lastModule: unknown | null }; errorLogs: ErrorLog[]; core: CoreApi }> {
	const root = workspaceRoot
	const capture = { lastModule: null as unknown, beginBatchCalls: 0, replaceModuleCalls: 0 }
	const errorLogs: ErrorLog[] = []
	const deps = resolveHMRDependencyConfig(baseDeps)
	const fsAllow = resolveFsAllowList({
		cwd: root,
		cwdNormalized: normalizePath(root),
		scanRoots: [normalizePath(fixturesPluginsDir)],
	})

	const hmr = new HMRService(createContext(capture, errorLogs), {
		roots: [fixturesPluginsRelFromWorkspace],
		entries: [],
		deps: baseDeps,
	})
	hmr.setServerRoot(root)
	const runnerPlugin = (hmr as unknown as { plugin: VitePlugin }).plugin

	const server = await createServer({
		...buildHmrViteConfig({
			root,
			fsAllow,
			scanRoots: [fixturesPluginsRelFromWorkspace],
			deps,
			runnerPlugin,
			honoPlugin: { name: 'noop' },
			port: 0,
		}),
		server: { middlewareMode: true, fs: { allow: fsAllow }, hmr: false, ws: false },
	})

	try {
		await hmr.executeFiles([pluginEntry])
		const core = (await (hmr as any).runner.import('@pluxel/core')) as CoreApi
		return { capture, errorLogs, core }
	} finally {
		await server.close()
	}
}

function createContext(
	capture: { lastModule: unknown | null; beginBatchCalls: number; replaceModuleCalls: number },
	errorLogs: ErrorLog[],
) {
	const anchors = new Set<string>()
	return {
		logger: {
			info: () => undefined,
			warn: () => undefined,
			error(obj: unknown, msg: string) {
				errorLogs.push({ msg, obj })
			},
		},
		scanService: { resolveEntry: async () => ({ ok: false }) },
		loader: {
			api: {
				anchors: {
					has: (id: string) => anchors.has(id),
					list: () => anchors,
					remove: (id: string) => anchors.delete(id),
				},
			},
			beginBatch() {
				capture.beginBatchCalls++
				return {
					replaceModule: async (_id: string, mod: unknown) => {
						capture.replaceModuleCalls++
						capture.lastModule = mod
						return false
					},
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

describe('configSourcePlugin integration', () => {
	it('injects __setConfigSource__ so getConfigSource returns schemaSource', async () => {
		const root = workspaceRoot
		const pluginEntry = join(root, fixturesPluginsRelFromWorkspace, 'PluginB.ts')
		const { capture, errorLogs, core } = await executePluginEntryAndCapture(pluginEntry)

		expect(errorLogs).toEqual([])
		expect(capture.lastModule).toBeTruthy()
		const ctor = (capture.lastModule as { PluginB?: unknown } | null)?.PluginB
		expect(typeof ctor).toBe('function')
		const map = core.getConfigSource(ctor)
		expect(map).toBeTruthy()
		expect(Object.keys(map ?? {})).toContain('a')
		expect(Object.keys(map ?? {})).toContain('ba')
	}, 20_000)

	it('supports configs.use(schema) fields (no @Config decorator)', async () => {
		const root = workspaceRoot
		const pluginEntry = join(root, fixturesPluginsRelFromWorkspace, 'PluginConfigUse.ts')
		const { capture, errorLogs, core } = await executePluginEntryAndCapture(pluginEntry)

		expect(errorLogs).toEqual([])
		expect(capture.lastModule).toBeTruthy()
		const ctor = (capture.lastModule as { PluginConfigUse?: unknown } | null)?.PluginConfigUse
		expect(typeof ctor).toBe('function')
		const map = core.getConfigSource(ctor)
		expect(map).toBeTruthy()
		expect(Object.keys(map ?? {})).toContain('foo')
	}, 20_000)

	it('supports features.use(FeatureCtor) without @UseFeature (dependency propagation)', async () => {
		const root = workspaceRoot
		const pluginEntry = join(root, fixturesPluginsRelFromWorkspace, 'PluginFeatureUse.ts')
		const { capture, errorLogs, core } = await executePluginEntryAndCapture(pluginEntry)

		expect(errorLogs).toEqual([])
		expect(capture.lastModule).toBeTruthy()
		const ctor = (capture.lastModule as { PluginFeatureUse?: unknown } | null)?.PluginFeatureUse
		expect(typeof ctor).toBe('function')
		const kv = (capture.lastModule as { KvPlugin?: unknown } | null)?.KvPlugin
		expect(typeof kv).toBe('function')
		expect(
			core.getRequiredPluginDependencies(ctor),
		).toContain(kv)
		expect(
			core.getUsedFeatures(ctor).map((x) => x.name),
		).toContain('CacheFeature')
	}, 20_000)
})
