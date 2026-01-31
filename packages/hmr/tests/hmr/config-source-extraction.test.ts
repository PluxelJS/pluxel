import { describe, expect, it } from 'bun:test'
import type { Context } from '@pluxel/core'
import { getConfigSource, getRequiredPluginDependencies, getUsedFeatures } from '@pluxel/core'
import { join } from 'pathe'
import { createServer, normalizePath, type Plugin as VitePlugin } from 'vite'
import {
	buildHmrViteConfig,
	type HMRDependencyConfig,
	resolveFsAllowList,
	resolveHMRDependencyConfig,
} from '../../src/services/hmr/config'
import { HMRService } from '../../src/services/hmr/HMRService'

const baseDeps: HMRDependencyConfig = {
	bridgeModules: [],
	ssrExternal: [],
	ssrNoExternal: [],
	optimizeDepsInclude: [],
	optimizeDepsInterop: [],
	cjsExternal: [],
}

type ErrorLog = { msg: string; obj: unknown }

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
		loader: {
			api: {
				anchors: {
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
		const root = process.cwd()
		const pluginEntry = join(root, 'tests', 'fixtures', 'plugins', 'PluginB.ts')
		const capture = { lastModule: null as unknown, beginBatchCalls: 0, replaceModuleCalls: 0 }
		const errorLogs: ErrorLog[] = []
		const deps = resolveHMRDependencyConfig(baseDeps)
		const fsAllow = resolveFsAllowList({
			cwd: root,
			cwdNormalized: normalizePath(root),
			scanRoots: [normalizePath(join(root, 'tests', 'fixtures', 'plugins'))],
		})

		const hmr = new HMRService(createContext(capture, errorLogs), {
			roots: ['tests/fixtures/plugins'],
			deps: baseDeps,
		})
		hmr.setServerRoot(root)
		const runnerPlugin = (hmr as unknown as { plugin: VitePlugin }).plugin

		const server = await createServer({
			...buildHmrViteConfig({
				root,
				fsAllow,
				scanRoots: ['tests/fixtures/plugins'],
				deps,
				runnerPlugin,
				honoPlugin: { name: 'noop' },
				port: 0,
			}),
			server: { middlewareMode: true, fs: { allow: fsAllow } },
		})

		try {
			await hmr.executeFiles([pluginEntry])
		} finally {
			await server.close()
		}

		expect(errorLogs).toEqual([])
		expect(capture.beginBatchCalls).toBeGreaterThan(0)
		expect(capture.replaceModuleCalls).toBeGreaterThan(0)
		expect(capture.lastModule).toBeTruthy()
		const ctor = (capture.lastModule as { PluginB?: unknown } | null)?.PluginB
		expect(typeof ctor).toBe('function')
		const map = getConfigSource(ctor as Parameters<typeof getConfigSource>[0])
		expect(map).toBeTruthy()
		expect(Object.keys(map ?? {})).toContain('a')
		expect(Object.keys(map ?? {})).toContain('ba')
	})

	it('supports configs.use(schema) fields (no @Config decorator)', async () => {
		const root = process.cwd()
		const pluginEntry = join(root, 'tests', 'fixtures', 'plugins', 'PluginConfigUse.ts')
		const capture = { lastModule: null as unknown, beginBatchCalls: 0, replaceModuleCalls: 0 }
		const errorLogs: ErrorLog[] = []
		const deps = resolveHMRDependencyConfig(baseDeps)
		const fsAllow = resolveFsAllowList({
			cwd: root,
			cwdNormalized: normalizePath(root),
			scanRoots: [normalizePath(join(root, 'tests', 'fixtures', 'plugins'))],
		})

		const hmr = new HMRService(createContext(capture, errorLogs), {
			roots: ['tests/fixtures/plugins'],
			deps: baseDeps,
		})
		hmr.setServerRoot(root)
		const runnerPlugin = (hmr as unknown as { plugin: VitePlugin }).plugin

		const server = await createServer({
			...buildHmrViteConfig({
				root,
				fsAllow,
				scanRoots: ['tests/fixtures/plugins'],
				deps,
				runnerPlugin,
				honoPlugin: { name: 'noop' },
				port: 0,
			}),
			server: { middlewareMode: true, fs: { allow: fsAllow } },
		})

		try {
			await hmr.executeFiles([pluginEntry])
		} finally {
			await server.close()
		}

		expect(errorLogs).toEqual([])
		expect(capture.lastModule).toBeTruthy()
		const ctor = (capture.lastModule as { PluginConfigUse?: unknown } | null)?.PluginConfigUse
		expect(typeof ctor).toBe('function')
		const map = getConfigSource(ctor as Parameters<typeof getConfigSource>[0])
		expect(map).toBeTruthy()
		expect(Object.keys(map ?? {})).toContain('foo')
	})

	it('supports features.use(FeatureCtor) without @UseFeature (dependency propagation)', async () => {
		const root = process.cwd()
		const pluginEntry = join(root, 'tests', 'fixtures', 'plugins', 'PluginFeatureUse.ts')
		const capture = { lastModule: null as unknown, beginBatchCalls: 0, replaceModuleCalls: 0 }
		const errorLogs: ErrorLog[] = []
		const deps = resolveHMRDependencyConfig(baseDeps)
		const fsAllow = resolveFsAllowList({
			cwd: root,
			cwdNormalized: normalizePath(root),
			scanRoots: [normalizePath(join(root, 'tests', 'fixtures', 'plugins'))],
		})

		const hmr = new HMRService(createContext(capture, errorLogs), {
			roots: ['tests/fixtures/plugins'],
			deps: baseDeps,
		})
		hmr.setServerRoot(root)
		const runnerPlugin = (hmr as unknown as { plugin: VitePlugin }).plugin

		const server = await createServer({
			...buildHmrViteConfig({
				root,
				fsAllow,
				scanRoots: ['tests/fixtures/plugins'],
				deps,
				runnerPlugin,
				honoPlugin: { name: 'noop' },
				port: 0,
			}),
			server: { middlewareMode: true, fs: { allow: fsAllow } },
		})

		try {
			await hmr.executeFiles([pluginEntry])
		} finally {
			await server.close()
		}

		expect(errorLogs).toEqual([])
		expect(capture.lastModule).toBeTruthy()
		const ctor = (capture.lastModule as { PluginFeatureUse?: unknown } | null)?.PluginFeatureUse
		expect(typeof ctor).toBe('function')
		const kv = (capture.lastModule as { KvPlugin?: unknown } | null)?.KvPlugin
		expect(typeof kv).toBe('function')
		expect(
			getRequiredPluginDependencies(ctor as Parameters<typeof getRequiredPluginDependencies>[0]),
		).toContain(kv as Parameters<typeof getRequiredPluginDependencies>[0])
		expect(
			getUsedFeatures(ctor as Parameters<typeof getUsedFeatures>[0]).map((x) => x.name),
		).toContain('CacheFeature')
	})
})
