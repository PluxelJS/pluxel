import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, createServer } from 'vite'
import { describe, expect, it, vi } from 'vitest'
import {
	pluginSourceVitePlugins,
	type PluginSourceVitePluginsOptions,
} from '../../src/vite/plugin-source.ts'

type PluginSourceConfig = Readonly<{
	server?: Readonly<{
		watch?: Readonly<{ ignored?: readonly string[] }>
	}>
}>

function pluginSourceConfig(
	options: PluginSourceVitePluginsOptions = {},
	input: { server?: { watch?: null } } = {},
): PluginSourceConfig {
	const plugins = pluginSourceVitePlugins({
		...options,
		lintGuard: false,
		configSource: false,
	}) as unknown as Array<{
		name?: string
		config?: (config: typeof input) => PluginSourceConfig
	}>
	const plugin = plugins.find((candidate) => candidate.name === 'pluxel:plugin-source')
	if (!plugin?.config) throw new Error('plugin source config plugin was not created')
	return plugin.config(input)
}

describe('Pluxel Plugin source Vite watcher policy', () => {
	it('ignores generated files by default while preserving an explicitly disabled watcher', () => {
		expect(pluginSourceConfig()).toMatchObject({
			server: { watch: { ignored: ['**/.pluxel/**'] } },
		})
		expect(pluginSourceConfig({}, { server: { watch: null } })).not.toHaveProperty('server')
	})
})

it.each(['development', 'distribution'] as const)(
	'keeps browser, SSR and production exports distinct in %s mode',
	async (packageMode) => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-vite-conditions-'))
		const packageRoot = join(root, 'node_modules', 'conditional-package')
		try {
			await mkdir(packageRoot, { recursive: true })
			await writeFile(
				join(packageRoot, 'package.json'),
				JSON.stringify({
					name: 'conditional-package',
					type: 'module',
					exports: {
						'.': {
							node: './node.js',
							development: './development.js',
							default: './browser.js',
						},
						'./source': { '@pluxel/source': './source.js', default: './browser.js' },
					},
				}),
			)
			await writeFile(join(packageRoot, 'node.js'), "export { createRequire } from 'node:module'")
			await writeFile(
				join(packageRoot, 'development.js'),
				"export const marker = 'browser-development'",
			)
			await writeFile(join(packageRoot, 'browser.js'), "export const marker = 'browser-production'")
			await writeFile(join(packageRoot, 'source.js'), "export const marker = 'pluxel-source'")
			await writeFile(
				join(root, 'entry.js'),
				"export { marker } from 'conditional-package'; export { marker as sourceMarker } from 'conditional-package/source'",
			)
			const config = {
				root,
				configFile: false as const,
				logLevel: 'silent' as const,
				optimizeDeps: { noDiscovery: true },
				plugins: pluginSourceVitePlugins({ packageMode, lintGuard: false, configSource: false }),
			}
			vi.stubEnv('NODE_ENV', 'development')
			const server = await createServer({
				...config,
				server: { middlewareMode: true, watch: null },
			})
			try {
				const browser = await server.environments.client!.pluginContainer.resolveId(
					'conditional-package',
					join(root, 'entry.js'),
				)
				expect(browser?.id).toBe(join(packageRoot, 'development.js'))
				const node = await server.ssrLoadModule('conditional-package')
				expect(node.createRequire).toBeTypeOf('function')
			} finally {
				await server.close()
			}
			vi.stubEnv('NODE_ENV', 'production')
			const output = await build({
				...config,
				build: {
					write: false,
					minify: false,
					lib: { entry: join(root, 'entry.js'), formats: ['es'] },
				},
			})
			const outputs = Array.isArray(output) ? output : [output]
			const code = outputs
				.flatMap((result) => {
					if (!('output' in result)) throw new Error('Expected an immediate Vite build result')
					return result.output
				})
				.filter((chunk) => chunk.type === 'chunk')
				.map((chunk) => chunk.code)
				.join('\n')
			expect(code).toContain('browser-production')
			expect(code).not.toContain('browser-development')
			expect(code.includes('pluxel-source')).toBe(packageMode === 'development')
		} finally {
			vi.unstubAllEnvs()
			await rm(root, { recursive: true, force: true })
		}
	},
)
