import { createDiskFixture } from '@pluxel/test/fixtures'
import { describe, expect, it } from 'vitest'
import { createServer, normalizePath, type Plugin, type ViteDevServer } from 'vite'
import { dynamicRuntimeVitePlugin } from '../src/vite.ts'

describe('dynamic Vite config generations', () => {
	it('retries a config generation after startup failure and awaits host cleanup on close', async () => {
		await using fixture = await createDiskFixture(
			{
				'pnpm-workspace.yaml': 'packages: []\n',
				'pluxel.loader.hmr.jsonc': JSON.stringify({
					version: 2,
					profile: 'test',
					defaults: { roots: [] },
					profiles: { test: { enabled: [] } },
				}),
			},
			{ tempDir: process.cwd() },
		)
		const root = fixture.path
		const configPath = fixture.getPath('pluxel.dynamic.ts')
		await fixture.writeFile(
			'pluxel.dynamic.ts',
			[
				"import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'",
				'export default defineDynamicRuntimeConfig({',
				`  root: ${JSON.stringify(root)},`,
				"  configPath: 'pluxel.loader.hmr.jsonc',",
				"  profile: 'test',",
				"  configService: { mode: 'memory' },",
				"  runtimeState: { mode: 'memory' },",
				'  logging: false,',
				'  printUrls: false,',
				'})',
				'',
			].join('\n'),
		)

		let generations = 0
		let disposed = 0
		const plugins = dynamicRuntimeVitePlugin({
			config: configPath,
			prepareHost(host) {
				generations++
				host.ctx.effects.defer(() => {
					disposed++
				})
				if (generations === 2) throw new Error('intentional generation failure')
			},
		})
		const route = plugins.at(-1) as Plugin
		const server = await createServer({
			configFile: false,
			root,
			cacheDir: fixture.getPath('.vite-cache'),
			logLevel: 'silent',
			optimizeDeps: { noDiscovery: true, include: [] },
			plugins: [
				...plugins,
				{
					name: 'test:disable-watch',
					enforce: 'post',
					config() {
						return { server: { watch: null } }
					},
				},
			],
			server: { middlewareMode: true },
		})

		try {
			expect(generations).toBe(1)
			expect(readController(server)).toBeDefined()

			await expect(callHotUpdate(route, server, configPath)).rejects.toThrow(
				'intentional generation failure',
			)
			expect(generations).toBe(2)
			expect(disposed).toBe(2)
			expect(readController(server)).toBeUndefined()

			await expect(callHotUpdate(route, server, configPath)).resolves.toEqual([])
			expect(generations).toBe(3)
			expect(readController(server)).toBeDefined()
		} finally {
			await server.close()
		}
		expect(disposed).toBe(3)
	}, 30_000)
})

function readController(server: ViteDevServer): unknown {
	return (server as unknown as Record<PropertyKey, unknown>)[
		Symbol.for('pluxel.dynamicRuntimeController')
	]
}

async function callHotUpdate(
	plugin: Plugin,
	server: ViteDevServer,
	file: string,
): Promise<unknown> {
	const hook = plugin.handleHotUpdate
	if (typeof hook !== 'function') throw new Error('dynamic route has no hot-update hook')
	return hook.call(plugin, {
		file: normalizePath(file),
		server,
		modules: [],
		read: () => Promise.resolve(''),
		timestamp: Date.now(),
	} as never)
}
