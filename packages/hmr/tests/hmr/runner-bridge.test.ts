import { describe, expect, it } from 'bun:test'
import { BasePlugin, checkPluginDecorator } from '@pluxel/core'
import { join } from 'pathe'
import { createServer, normalizePath } from 'vite'
import {
	buildHmrViteConfig,
	resolveFsAllowList,
	resolveHMRDependencyConfig,
} from '../../src/services/hmr/config'
import { HMRService } from '../../src/services/hmr/HMRService'

// Minimal ctx stub to construct HMRService without booting the whole app.
const createCtx = () => {
	const anchors = new Set<string>()
	return {
		logger: { info() {}, error() {}, warn() {} },
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
		honoService: { viteHonoDevServer: { name: 'noop', apply: 'serve', configureServer() {} } },
	} as any
}

describe('HMR runner bridge', () => {
	it('reuses host @pluxel/core singletons in the runner', async () => {
		const cwd = process.cwd()
		const pluginFile = join(cwd, 'tests/demo/PluginWithUI.ts')

		const ctx = createCtx()
		const hmr = new HMRService(ctx, {
			dir: [join(cwd, 'tests/fixtures/plugins'), join(cwd, 'tests/demo')],
			log: { useColors: false },
		})
		hmr.setServerRoot(cwd)

		const deps = resolveHMRDependencyConfig()
		const fsAllow = resolveFsAllowList({
			cwd,
			cwdNormalized: normalizePath(cwd),
			scanRoots: [
				normalizePath(join(cwd, 'tests/fixtures/plugins')),
				normalizePath(join(cwd, 'tests/demo')),
			],
		})

		const server = await createServer({
			...buildHmrViteConfig({
				root: cwd,
				fsAllow,
				scanDirs: ['./tests/fixtures/plugins', './tests/demo'],
				deps,
				runnerPlugin: { name: 'noop' },
				honoPlugin: { name: 'noop' },
			}),
			server: {
				port: 0,
				middlewareMode: true,
				fs: { allow: fsAllow },
			},
		})
		try {
			;(hmr as any).runner.init(server)
			await (hmr as any).runner.bridgeHostModules(deps.bridgeModules, hmr.path, ctx.logger)

			const mod = await (hmr as any).runner.import(pluginFile)
			expect(typeof mod?.PluginWithUI).toBe('function')
			expect(Object.getPrototypeOf(mod.PluginWithUI)).toBe(BasePlugin)
			expect(checkPluginDecorator(mod.PluginWithUI)).toBe(true)
		} finally {
			await server.close()
		}
	})
})
