import { describe, expect, it } from 'vitest'
import type { Context } from '@pluxel/core'
import { BasePlugin, checkPluginDecorator } from '@pluxel/core'
import { join } from 'pathe'
import { createServer, normalizePath } from 'vite'
import {
	buildHmrViteConfig,
	resolveFsAllowList,
	resolveHMRDependencyConfig,
} from '../../src/services/runtime/hmr/config'
import { HMRService } from '../../src/services/runtime/hmr/HMRService'
import { HmrRunner } from '../../src/services/runtime/hmr/runner'

// Minimal ctx stub to construct HMRService without booting the whole app.
const createCtx = () => {
	const anchors = new Set<string>()
	return {
		logger: { info: () => undefined, error: () => undefined, warn: () => undefined },
		scanService: { resolveEntry: async () => ({ ok: false }) },
		loader: {
			api: {
				anchors: {
					list: () => anchors,
					remove: (id: string) => anchors.delete(id),
				},
			},
		},
		registry: {
			commit: async () => ({ ok: true }),
			container: { services: new Map() },
		},
		honoService: {
			viteHonoDevServer: { name: 'noop', apply: 'serve', configureServer: () => undefined },
		},
	} as unknown as Context
}

describe('HMR runner bridge', () => {
	it('reuses host @pluxel/core singletons in the runner', async () => {
		const cwd = process.cwd()
		const fixturesDir = join(cwd, 'tests/fixtures/plugins')
		const pluginFile = join(fixturesDir, 'PluginWithUI.ts')

		const ctx = createCtx()
		const hmr = new HMRService(ctx, {
			roots: ['tests/fixtures/plugins'],
			entries: [],
		})
		hmr.setServerRoot(cwd)

		const deps = resolveHMRDependencyConfig()
		const fsAllow = resolveFsAllowList({
			cwd,
			cwdNormalized: normalizePath(cwd),
			scanRoots: [normalizePath(fixturesDir)],
		})

		const server = await createServer({
			...buildHmrViteConfig({
				root: cwd,
				fsAllow,
				scanRoots: ['tests/fixtures/plugins'],
				deps,
				runnerPlugin: { name: 'noop' },
				honoPlugin: { name: 'noop' },
			}),
			server: {
				port: 0,
				hmr: false,
				ws: false,
				middlewareMode: true,
				fs: { allow: fsAllow },
			},
		})
		try {
			const runner = new HmrRunner()
			runner.init(server)
			await runner.bridgeHostModules(deps.bridgeModules, hmr.path, { warn: () => undefined })
			await runner.assertBridgedSingletons(deps.bridgeModules)

			const mod = (await runner.import(pluginFile)) as Record<string, unknown>
			const ctor = mod.PluginWithUI as unknown
			expect(typeof ctor).toBe('function')

			const pluginCtor = ctor as unknown as typeof BasePlugin
			expect(Object.getPrototypeOf(pluginCtor)).toBe(BasePlugin)
			expect(checkPluginDecorator(pluginCtor)).toBe(true)
		} finally {
			await server.close()
		}
	}, 20_000)
})
