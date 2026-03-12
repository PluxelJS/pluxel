import { describe, expect, it } from 'vitest'
import type { Context } from '@pluxel/core'
import { join, normalize, relative } from 'pathe'
import { HMRService } from '@pluxel/hmr/services/runtime/hmr/HMRService'
import { fixturesPluginsDir, workspaceRoot } from './_paths'

const noop = () => undefined

function createNoopLogger() {
	const self: any = {
		trace: noop,
		debug: noop,
		info: noop,
		warn: noop,
		error: noop,
		fatal: noop,
		with: () => self,
	}
	return {
		...self,
		getDebugChannel: () => self,
	}
}

// Minimal ctx stub to construct HMRService without booting Vite.
const createCtx = () => {
	const anchors = new Set<string>()
	return {
		logger: createNoopLogger(),
		on: () => noop,
		scanService: { resolveEntry: async () => ({ ok: false }) },
		loader: {
			api: {
				anchors: {
					has: (id: string) => anchors.has(id),
					list: () => anchors,
					remove: (id: string) => anchors.delete(id),
				},
			},
			replaceModule: async () => true,
			pruneModule: () => undefined,
		},
		registry: {
			commit: async () => ({}),
			container: { services: new Map() },
		},
		http: {
			vitePlugin: { name: 'noop', apply: 'serve', configureServer: () => undefined },
		},
	} as unknown as Context
}

const pkgRoot = workspaceRoot
const pluginDir = fixturesPluginsDir
const pluginFile = join(pluginDir, 'PluginA.ts')

describe('HMRService file filter', () => {
	it('accepts relative, absolute and /@fs watcher paths inside scan roots', () => {
		const ctx = createCtx()
		const hmr = new HMRService(ctx, {
			roots: [pluginDir],
			entries: [],
		})
		// Simulate Vite configuring server root to packages/hmr (matches real dev script)
		hmr.setServerRoot(pkgRoot)

		const filter = hmr.toolkit.pathFilter
		// Relative watcher paths are resolved against HMRService cwd (process.cwd()).
		// This test suite can be executed from either workspace root or package root, so compute it dynamically.
		const relPath = normalize(relative(process.cwd(), pluginFile))
		const cleanRel = hmr.normalizeId(relPath)

		expect(cleanRel).toBe(pluginFile)
		expect(filter(relPath)).toBe(true)
		expect(filter(pluginFile)).toBe(true)
		expect(filter(`/@fs${pluginFile}`)).toBe(true)
		expect(filter(join(pkgRoot, 'node_modules/some/pkg/index.ts'))).toBe(false)
	})
})
