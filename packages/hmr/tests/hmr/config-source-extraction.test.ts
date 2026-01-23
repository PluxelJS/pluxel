import { describe, expect, it } from 'bun:test'
import { getConfigSource, getRequiredPluginDependencies, getUsedFeatures } from '@pluxel/core'
import { join } from 'pathe'
import { createServer, normalizePath } from 'vite'
import {
	buildHmrViteConfig,
	resolveFsAllowList,
	resolveHMRDependencyConfig,
} from '../../src/services/hmr/config'
import { HMRService } from '../../src/services/hmr/HMRService'

const baseDeps = {
	bridgeModules: [],
	ssrExternal: [],
	ssrNoExternal: [],
	optimizeDepsInclude: [],
	optimizeDepsInterop: [],
	cjsExternal: [],
}

type ErrorLog = { msg: string; obj: any }

function createContext(
	capture: { lastModule: any | null; beginBatchCalls: number; replaceModuleCalls: number },
	errorLogs: ErrorLog[],
) {
	const anchors = new Set<string>()
	return {
		logger: {
			info() {},
			warn() {},
			error(obj: any, msg: string) {
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
					replaceModule: async (_id: string, mod: any) => {
						capture.replaceModuleCalls++
						capture.lastModule = mod
						return false
					},
					rollback() {},
					commit() {},
				}
			},
			pruneModule() {},
		},
		registry: {
			commit: async () => ({ ok: true }),
			resetDraft() {},
			container: { services: new Map() },
		},
		honoService: { viteHonoDevServer: { name: 'noop', apply: 'serve', configureServer() {} } },
	} as any
}

describe('configSourceVitePlugin integration', () => {
	it('injects __setConfigSource__ so getConfigSource returns schemaSource', async () => {
		const root = process.cwd()
		const pluginEntry = join(root, 'tests', 'fixtures', 'plugins', 'PluginB.ts')
		const capture = { lastModule: null as any, beginBatchCalls: 0, replaceModuleCalls: 0 }
		const errorLogs: ErrorLog[] = []
		const deps = resolveHMRDependencyConfig(baseDeps as any)
		const fsAllow = resolveFsAllowList({
			cwd: root,
			cwdNormalized: normalizePath(root),
			scanRoots: [normalizePath(join(root, 'tests', 'fixtures', 'plugins'))],
		})

		const hmr = new HMRService(createContext(capture, errorLogs), {
			dir: ['tests/fixtures/plugins'],
			attribution: 'off',
			deps: baseDeps as any,
			log: { useColors: false },
		})
		hmr.setServerRoot(root)

		const server = await createServer({
			...buildHmrViteConfig({
				root,
				fsAllow,
				scanDirs: ['tests/fixtures/plugins'],
				deps,
				runnerPlugin: (hmr as any).plugin,
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
		const ctor = capture.lastModule?.PluginB
		expect(typeof ctor).toBe('function')
		const map = getConfigSource(ctor as any)
		expect(map).toBeTruthy()
		expect(Object.keys(map ?? {})).toContain('a')
		expect(Object.keys(map ?? {})).toContain('ba')
	})

	it('supports configs.use(schema) fields (no @Config decorator)', async () => {
		const root = process.cwd()
		const pluginEntry = join(root, 'tests', 'fixtures', 'plugins', 'PluginConfigUse.ts')
		const capture = { lastModule: null as any, beginBatchCalls: 0, replaceModuleCalls: 0 }
		const errorLogs: ErrorLog[] = []
		const deps = resolveHMRDependencyConfig(baseDeps as any)
		const fsAllow = resolveFsAllowList({
			cwd: root,
			cwdNormalized: normalizePath(root),
			scanRoots: [normalizePath(join(root, 'tests', 'fixtures', 'plugins'))],
		})

		const hmr = new HMRService(createContext(capture, errorLogs), {
			dir: ['tests/fixtures/plugins'],
			attribution: 'off',
			deps: baseDeps as any,
			log: { useColors: false },
		})
		hmr.setServerRoot(root)

		const server = await createServer({
			...buildHmrViteConfig({
				root,
				fsAllow,
				scanDirs: ['tests/fixtures/plugins'],
				deps,
				runnerPlugin: (hmr as any).plugin,
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
		const ctor = capture.lastModule?.PluginConfigUse
		expect(typeof ctor).toBe('function')
		const map = getConfigSource(ctor as any)
		expect(map).toBeTruthy()
		expect(Object.keys(map ?? {})).toContain('foo')
	})

	it('supports features.use(FeatureCtor) without @UseFeature (dependency propagation)', async () => {
		const root = process.cwd()
		const pluginEntry = join(root, 'tests', 'fixtures', 'plugins', 'PluginFeatureUse.ts')
		const capture = { lastModule: null as any, beginBatchCalls: 0, replaceModuleCalls: 0 }
		const errorLogs: ErrorLog[] = []
		const deps = resolveHMRDependencyConfig(baseDeps as any)
		const fsAllow = resolveFsAllowList({
			cwd: root,
			cwdNormalized: normalizePath(root),
			scanRoots: [normalizePath(join(root, 'tests', 'fixtures', 'plugins'))],
		})

		const hmr = new HMRService(createContext(capture, errorLogs), {
			dir: ['tests/fixtures/plugins'],
			attribution: 'off',
			deps: baseDeps as any,
			log: { useColors: false },
		})
		hmr.setServerRoot(root)

		const server = await createServer({
			...buildHmrViteConfig({
				root,
				fsAllow,
				scanDirs: ['tests/fixtures/plugins'],
				deps,
				runnerPlugin: (hmr as any).plugin,
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
		const ctor = capture.lastModule?.PluginFeatureUse
		expect(typeof ctor).toBe('function')
		const kv = capture.lastModule?.KvPlugin
		expect(typeof kv).toBe('function')
		expect(getRequiredPluginDependencies(ctor as any)).toContain(kv as any)
		expect(getUsedFeatures(ctor as any).map((x: any) => x?.name)).toContain('CacheFeature')
	})
})
