import { describe, expect, it } from 'vitest'
import type { Context } from '@pluxel/core'
import { join } from 'pathe'
import { createServer, normalizePath } from 'vite'
import { fixturesPluginsDir, fixturesPluginsRelFromWorkspace, workspaceRoot } from './_paths'
import {
	buildHmrViteConfig,
	resolveFsAllowList,
	resolveHMRDependencyConfig,
} from '../../src/services/runtime/hmr/config'
import { HMRService } from '../../src/services/runtime/hmr/HMRService'
import { HmrRunner } from '../../src/services/runtime/hmr/runner'

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

// Minimal ctx stub to construct HMRService without booting the whole app.
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
		const cwd = workspaceRoot
		const fixturesDir = fixturesPluginsDir
		const pluginFile = join(fixturesDir, 'PluginWithUI.ts')

		const ctx = createCtx()
		const hmr = new HMRService(ctx, {
			roots: [fixturesPluginsRelFromWorkspace],
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
				scanRoots: [fixturesPluginsRelFromWorkspace],
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
			await runner.bridgeHostModules(deps.bridgeModules, hmr.path, {
				warn: () => undefined,
			})
			expect((runner as any).bridgedRunnerUrls?.has?.('/packages/context/src/index.ts')).toBe(true)
			await runner.assertBridgedSingletons(deps.bridgeModules)

			const hostCore = (runner as any).bridgedHostExports?.get?.('@pluxel/core') as
				| { BasePlugin?: unknown; checkPluginDecorator?: unknown }
				| undefined
			expect(hostCore).toBeTruthy()

			const mod = (await runner.import(pluginFile)) as Record<string, unknown>
			const ctor = mod.PluginWithUI as unknown
			expect(typeof ctor).toBe('function')

			const BasePlugin = hostCore?.BasePlugin as unknown
			const checkPluginDecorator = hostCore?.checkPluginDecorator as unknown
			expect(typeof BasePlugin).toBe('function')
			expect(typeof checkPluginDecorator).toBe('function')

			const pluginCtor = ctor as unknown as { prototype?: unknown }
			expect(Object.getPrototypeOf(pluginCtor)).toBe(BasePlugin)
			expect((checkPluginDecorator as (c: unknown) => boolean)(pluginCtor)).toBe(true)
		} finally {
			await server.close()
		}
	}, 20_000)
})
