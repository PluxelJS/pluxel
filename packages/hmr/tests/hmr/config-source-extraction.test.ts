import { describe, expect, it } from 'vitest'
import type { Context } from '@pluxel/core'
import { join } from 'pathe'
import { rmSync, symlinkSync } from 'node:fs'
import { createServer, normalizePath, type Plugin as VitePlugin } from 'vite'
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

type ErrorLog = { msg: string; obj: unknown }
type CoreApi = {
	getConfigSource: (ctor: unknown) => Record<string, unknown> | null
	getRequiredPluginDependencies: (ctor: unknown) => unknown[]
	getUsedFeatures: (ctor: unknown) => Array<{ name: string }>
}

const noop = () => {}

function createNoopLogger(errorLogs: ErrorLog[]) {
	const channel: any = {
		trace: noop,
		debug: noop,
		info: noop,
		warn: noop,
		error: noop,
		fatal: noop,
		with: () => channel,
	}

	return {
		...channel,
		getDebugChannel: () => channel,
		error(messageOrObj: unknown, maybeProps?: unknown) {
			if (typeof messageOrObj === 'string') {
				errorLogs.push({ msg: messageOrObj, obj: maybeProps })
				return
			}
			if (typeof maybeProps === 'string') {
				errorLogs.push({ msg: maybeProps, obj: messageOrObj })
			}
		},
	}
}

async function executePluginEntryAndCapture(
	pluginEntry: string,
	opts?: {
		rootsRelFromWorkspace?: string
		scanRootsAbs?: string[]
		include?: string[]
		exclude?: string[]
	},
): Promise<{ capture: { lastModule: unknown | null }; errorLogs: ErrorLog[]; core: CoreApi }> {
	const root = workspaceRoot
	const capture = { lastModule: null as unknown, beginBatchCalls: 0, replaceModuleCalls: 0 }
	const errorLogs: ErrorLog[] = []
	const deps = resolveHMRDependencyConfig(baseDeps)
	const rootsRel = opts?.rootsRelFromWorkspace ?? fixturesPluginsRelFromWorkspace
	const scanRootsAbs = opts?.scanRootsAbs ?? [normalizePath(fixturesPluginsDir)]
	const fsAllow = resolveFsAllowList({
		cwd: root,
		cwdNormalized: normalizePath(root),
		scanRoots: scanRootsAbs,
	})

	const hmr = new HMRService(createContext(capture, errorLogs), {
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
		logger: createNoopLogger(errorLogs),
		on: () => noop,
		configService: { isReady: true, ready: Promise.resolve() },
		scanService: { resolveEntry: async () => ({ ok: false }) },
		loader: {
			api: {
				anchors: {
					has: (id: string) => anchors.has(id),
					list: () => anchors,
					snapshot: () => new Set(anchors),
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
					rollback: () => {},
					commit: () => {},
				}
			},
			pruneModule: () => {},
		},
		registry: {
			commit: async () => ({ ok: true }),
			resetDraft: () => {},
			container: { services: new Map() },
		},
		http: {
			vitePlugin: { name: 'noop', apply: 'serve', configureServer: () => {} },
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
			const { capture, errorLogs, core } = await executePluginEntryAndCapture(pluginEntry, {
				rootsRelFromWorkspace: rootsRel,
				scanRootsAbs: [normalizePath(linkAbs)],
			})

			expect(errorLogs).toEqual([])
			expect(capture.lastModule).toBeTruthy()
			const ctor = (capture.lastModule as { PluginConfigUse?: unknown } | null)?.PluginConfigUse
			expect(typeof ctor).toBe('function')
			const map = core.getConfigSource(ctor)
			expect(map).toBeTruthy()
			expect(Object.keys(map ?? {})).toContain('foo')
		} finally {
			rmSync(linkAbs, { recursive: true, force: true })
		}
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
		expect(core.getRequiredPluginDependencies(ctor)).toContain(kv)
		expect(core.getUsedFeatures(ctor).map((x) => x.name)).toContain('CacheFeature')
	}, 20_000)
})
