import { describe, expect, it } from 'vitest'
import type { Context } from '@pluxel/core'
import { join } from 'pathe'
import { createServer, normalizePath } from 'vite'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { workspaceRoot } from './_paths'
import {
	buildLoaderHmrViteConfig,
	resolveFsAllowList,
	resolveLoaderHmrDependencyConfig,
} from '../../src/hmr/engine/config'
import { LoaderHmrService } from '../../src/hmr/engine/LoaderHmrService'
import { HmrRunner } from '../../src/hmr/engine/runner'
import { createEventContextStub, createNoopLogger } from './_stubs'

// Minimal ctx stub to construct LoaderHmrService without booting the whole app.
const createCtx = () => {
	const anchors = new Set<string>()
	return {
		logger: createNoopLogger(),
		...createEventContextStub(),
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
		http: {
			vitePlugin: { name: 'noop', apply: 'serve', configureServer: () => {} },
		},
	} as unknown as Context
}

describe('HMR runner bridge', () => {
	it('reuses host @pluxel/core singletons in the runner', async () => {
		const cwd = workspaceRoot
		await using fixture = await createFixture({
			'PluginWithUI.ts': [
				"import { BasePlugin, Plugin } from '@pluxel/core'",
				'',
				'export class PluginWithUI extends BasePlugin {}',
				"Plugin({ name: 'PluginWithUI' })(PluginWithUI)",
				'',
			].join('\n'),
		})
		const fixturesDir = fixture.path
		const pluginFile = join(fixturesDir, 'PluginWithUI.ts')

		const ctx = createCtx()
		const hmr = new LoaderHmrService(ctx, {
			roots: [fixturesDir],
			entries: [],
		})
		hmr.setServerRoot(cwd)

		const deps = resolveLoaderHmrDependencyConfig()
		const fsAllow = resolveFsAllowList({
			cwd,
			cwdNormalized: normalizePath(cwd),
			scanRoots: [normalizePath(fixturesDir)],
		})

		const server = await createServer({
			...buildLoaderHmrViteConfig({
				root: cwd,
				fsAllow,
				deps,
				runnerPlugin: { name: 'noop' },
				httpPlugin: { name: 'noop' },
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
			runner.init(server, {
				hostCwd: cwd,
				bridgeProviders: deps.bridgeProviders,
			})
			await runner.bridgeHostModules(deps.bridgeModules, hmr.path, {
				warn: () => {},
			})
			expect((runner as any).bridgedRunnerUrls?.has?.('/packages/core/src/index.ts')).toBe(true)
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
	}, 60_000)
})
