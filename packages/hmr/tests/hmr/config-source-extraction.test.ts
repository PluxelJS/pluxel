import { describe, expect, it } from 'bun:test'
import { join } from 'pathe'
import { createServer, normalizePath } from 'vite'
import { getConfigSource } from '@pluxel/core'
import { HMRService } from '../../src/services/hmr/HMRService'
import {
	buildHmrViteConfig,
	resolveFsAllowList,
	resolveHMRDependencyConfig,
} from '../../src/services/hmr/config'

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
		const pluginEntry = join(root, 'tests', 'plugins', 'PluginB.ts')
		const capture = { lastModule: null as any, beginBatchCalls: 0, replaceModuleCalls: 0 }
		const errorLogs: ErrorLog[] = []
		const deps = resolveHMRDependencyConfig(baseDeps as any)
		const fsAllow = resolveFsAllowList({
			cwd: root,
			cwdNormalized: normalizePath(root),
			scanRoots: [normalizePath(join(root, 'tests', 'plugins'))],
		})

		const hmr = new HMRService(createContext(capture, errorLogs), {
			dir: ['tests/plugins'],
			attribution: 'off',
			deps: baseDeps as any,
			log: { useColors: false },
		})
		hmr.setServerRoot(root)

		const server = await createServer({
			...buildHmrViteConfig({
				root,
				fsAllow,
				scanDirs: ['tests/plugins'],
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
})
