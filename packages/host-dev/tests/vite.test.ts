import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { describe, expect, it } from 'vitest'
import {
	createServer,
	createRunnableDevEnvironment,
	type RunnableDevEnvironment,
	type InlineConfig,
	type Plugin,
	type ViteDevServer,
} from 'vite'
import { pluginSourceVitePlugins, createPluginSourceVitePipeline } from '@pluxel/rolldown/vite'

import { hostSingletons } from '../src/vite'
import { createHostModuleClassifier } from '../src/host-modules'
import {
	hostEnvironment,
	HOST_VITE_ENVIRONMENT,
	getHostModuleRunner,
	importHostModule,
	invalidateHostModule,
	invalidateHostModuleGraphFiles,
} from '../src/environment'

function createTestViteServer(config: InlineConfig): Promise<ViteDevServer> {
	return createServer({
		logLevel: 'silent',
		server: { middlewareMode: true },
		appType: 'custom',
		optimizeDeps: { noDiscovery: true, include: [] },
		...config,
		plugins: [hostEnvironment(), ...(config.plugins ?? [])],
	})
}

async function withTestViteServer<T>(
	config: InlineConfig,
	run: (server: ViteDevServer) => Promise<T>,
): Promise<T> {
	const server = await createTestViteServer(config)
	try {
		return await run(server)
	} finally {
		await server.close()
	}
}

function hostSourcePlugins(options: Parameters<typeof createPluginSourceVitePipeline>[0] = {}) {
	return [
		...createPluginSourceVitePipeline({ ...options, environment: HOST_VITE_ENVIRONMENT }).plugins,
	]
}

describe('host-dev Vite plugin stack', () => {
	it('exposes source/server semantics as a dedicated plugin', () => {
		const plugins = pluginSourceVitePlugins() as Plugin[]
		const plugin = plugins.at(-1)!
		const config = plugin.config?.({} as never, { command: 'serve', mode: 'development' }) as {
			resolve?: { conditions?: string[]; externalConditions?: string[]; dedupe?: string[] }
			ssr?: {
				external?: string[]
				resolve?: { conditions?: string[]; externalConditions?: string[] }
			}
			oxc?: { decorator?: { legacy?: boolean; emitDecoratorMetadata?: boolean } }
		}

		expect(plugin.name).toBe('pluxel:plugin-source')
		expect(config.resolve?.conditions?.slice(0, 2)).toEqual(['@pluxel/hmr', '@pluxel/source'])
		expect(config.ssr?.resolve?.conditions).toEqual(
			expect.arrayContaining(['@pluxel/source', 'module', 'node', 'development|production']),
		)
		expect(config.resolve?.externalConditions).not.toContain('@pluxel/source')
		expect(config.resolve?.externalConditions).toEqual(['node', 'import', 'default'])
		expect(config.ssr?.resolve?.externalConditions).toEqual(['node', 'import', 'default'])
		expect(config.resolve?.dedupe).toBeUndefined()
		expect(config.ssr?.external).toEqual([])
		expect(config.oxc?.decorator?.legacy).toBe(true)
		expect(config.oxc?.decorator?.emitDecoratorMetadata).toBe(false)
	})

	it('pins selected service entries to their native application installation', async () => {
		await using fixture = await createDiskFixture()
		const root = fixture.path
		await writePackage(
			root,
			'@acme/services',
			{
				name: '@acme/services',
				type: 'module',
				exports: {
					'./commands': './index.js',
					'./persistence': './index.js',
					'./vault': './index.js',
					'./internal/security': './index.js',
				},
			},
			'export const token = {}; export default token\n',
		)
		const modulePath = join(root, 'entry.ts')
		await writeFile(modulePath, "export { token } from '@acme/services/vault'\n")
		const native = await import(
			/* @vite-ignore */ pathToFileURL(join(root, 'node_modules/@acme/services/index.js')).href
		)
		await withTestViteServer(
			{
				root,
				plugins: [
					{
						name: 'test:early-host-singleton-consumer',
						enforce: 'pre',
						async configureServer(server) {
							const mod = await getHostModuleRunner(server).import<{ token: object }>(modulePath)
							expect(mod.token).toBe(native.token)
						},
					},
					hostSingletons({ packages: ['@acme/services'] }),
				],
			},
			async (server) => {
				const first = await importHostModule<{ token: object }>(server, modulePath)
				expect(first.token).toBe(native.token)
				for (const source of [
					'@acme/services/commands',
					'@acme/services/persistence',
					'@acme/services/vault',
					'@acme/services/internal/security',
				]) {
					const result = await server.environments[HOST_VITE_ENVIRONMENT].pluginContainer.resolveId(
						source,
						modulePath,
					)
					expect(result).toMatchObject({ external: true })
				}
			},
		)
	})

	it('leaves distribution bare packages to the Node host', () => {
		const plugins = pluginSourceVitePlugins({ packageMode: 'distribution' }) as Plugin[]
		const plugin = plugins.at(-1)!
		const config = plugin.config?.({} as never, {
			command: 'serve',
			mode: 'production',
		}) as {
			resolve?: { conditions?: string[] }
			ssr?: { external?: string[] | true }
		}

		expect(config.resolve?.conditions).not.toContain('@pluxel/source')
		expect(config.ssr?.external).toBe(true)
	})

	it('applies preprocessor semantics through the real Vite module runner', async () => {
		await using fixture = await createDiskFixture({}, { tempDir: process.cwd() })
		const root = fixture.path
		const modulePath = join(root, 'plugin.ts')
		await writeFile(
			modulePath,
			[
				'// #define PLUXEL_PIPELINE',
				'',
				'// #if PLUXEL_PIPELINE',
				"export const branch = 'included'",
				'// #else',
				"export const branch = 'excluded'",
				'// #endif',
				'',
			].join('\n'),
		)

		await withTestViteServer(
			{
				root,
				plugins: hostSourcePlugins({ lintGuard: false, configSource: false }),
			},
			async (server) => {
				const mod = await importHostModule<{ branch: string }>(server, modulePath)
				expect(mod.branch).toBe('included')
			},
		)
	})

	it('uses Node conditions for external packages in the real Vite runner', async () => {
		await using fixture = await createDiskFixture()
		const root = fixture.path
		const entryPath = join(root, 'entry.ts')
		await writePackage(root, 'fixture-bundler-condition', {
			name: 'fixture-bundler-condition',
			type: 'module',
			exports: { module: './bundler.js', default: './node.cjs' },
		})
		await Promise.all([
			writeFile(
				join(root, 'node_modules', 'fixture-bundler-condition', 'bundler.js'),
				"import './missing-extension'\nexport default 'bundler'\n",
			),
			writeFile(
				join(root, 'node_modules', 'fixture-bundler-condition', 'node.cjs'),
				"module.exports = 'node'\n",
			),
			writeFile(
				entryPath,
				"import selected from 'fixture-bundler-condition'\nexport { selected }\n",
			),
		])

		await withTestViteServer(
			{
				root,
				environments: {
					[HOST_VITE_ENVIRONMENT]: { resolve: { external: ['fixture-bundler-condition'] } },
				},
				plugins: [
					...hostSourcePlugins({
						lintGuard: false,
						configSource: false,
					}),
				],
			},
			async (server) => {
				const mod = await importHostModule<{ selected: string }>(server, entryPath)
				expect(mod.selected).toBe('node')
			},
		)
	})

	it('classifies CommonJS and native packages for Node externalization', async () => {
		await using fixture = await createDiskFixture()
		const root = fixture.path
		const legacyEsmRoot = join(root, 'node_modules', 'fixture-legacy-esm')
		await Promise.all([
			writePackage(
				root,
				'fixture-commonjs',
				{ type: 'commonjs', main: './index.js' },
				'module.exports = true\n',
			),
			writePackage(root, 'fixture-misleading-module', { main: './index.js', module: './index.js' }),
			writePackage(root, 'fixture-native', { type: 'module', napi: { name: 'fixture-native' } }),
			writePackage(root, 'fixture-esm', { type: 'module', main: './index.js' }),
			writePackage(root, 'fixture-legacy-esm', {
				type: 'commonjs',
				main: './build/src/index.js',
				module: './build/esm/index.js',
			}),
			mkdir(join(legacyEsmRoot, 'build', 'src'), { recursive: true }).then(() =>
				writeFile(join(legacyEsmRoot, 'build', 'src', 'index.js'), 'module.exports = true\n'),
			),
			mkdir(join(legacyEsmRoot, 'build', 'esm'), { recursive: true }).then(() =>
				Promise.all([
					writeFile(join(legacyEsmRoot, 'build', 'esm', 'index.js'), 'export default true\n'),
					writeFile(join(legacyEsmRoot, 'build', 'esm', 'internal.js'), 'export default true\n'),
					writeFile(join(legacyEsmRoot, 'build', 'esm', 'compat.cjs'), 'module.exports = true\n'),
				]),
			),
		])
		await writeFile(
			join(root, 'node_modules', 'fixture-misleading-module', 'index.js'),
			'exports.value = true\n',
		)
		const classifier = createHostModuleClassifier()
		expect(
			await Promise.all([
				classifier.classifyFile(join(root, 'node_modules/fixture-commonjs/index.js')),
				classifier.classifyFile(join(root, 'node_modules/fixture-misleading-module/index.js')),
				classifier.classifyFile(join(root, 'node_modules/fixture-native/index.js')),
				classifier.classifyFile(join(root, 'node_modules/fixture-esm/index.js')),
				classifier.classifyFile(join(legacyEsmRoot, 'build/esm/index.js')),
			]),
		).toEqual([
			expect.objectContaining({ format: 'commonjs', reason: 'commonjs' }),
			expect.objectContaining({ format: 'commonjs', reason: 'commonjs' }),
			expect.objectContaining({ reason: 'native' }),
			null,
			null,
		])
		expect(
			await classifier.classifyFile(join(legacyEsmRoot, 'build', 'esm', 'internal.js')),
		).toBeNull()
		expect(
			await classifier.classifyFile(join(legacyEsmRoot, 'build', 'esm', 'compat.cjs')),
		).toEqual(expect.objectContaining({ format: 'commonjs', reason: 'commonjs' }))
		expect(await classifier.classifyFile(join(legacyEsmRoot, 'build', 'src', 'index.js'))).toEqual(
			expect.objectContaining({ format: 'commonjs', reason: 'commonjs' }),
		)
	})

	it('isolates Host source conditions from default SSR loading', async () => {
		await using fixture = await createDiskFixture()
		const root = fixture.path
		const entryPath = join(root, 'entry.ts')
		await writePackage(root, 'fixture-dual', {
			name: 'fixture-dual',
			type: 'module',
			exports: { module: './index.mjs', node: './index.cjs', default: './index.mjs' },
		})
		await Promise.all([
			writeFile(join(root, 'node_modules', 'fixture-dual', 'index.mjs'), 'export default 42\n'),
			writeFile(join(root, 'node_modules', 'fixture-dual', 'index.cjs'), 'module.exports = 21\n'),
			writeFile(entryPath, "import answer from 'fixture-dual'\nexport { answer }\n"),
		])

		await withTestViteServer(
			{
				root,
				plugins: hostSourcePlugins({ lintGuard: false, configSource: false }),
			},
			async (server) => {
				const mod = await importHostModule<{ answer: number }>(server, entryPath)
				expect(mod.answer).toBe(42)
				const compat = await server.ssrLoadModule(entryPath)
				expect(compat.answer).toBe(21)
				expect(server.environments.client.config.resolve.conditions).toContain('@pluxel/source')
				expect(server.environments.ssr.config.resolve.conditions).not.toContain('@pluxel/source')
			},
		)
	})

	it('keeps the Host environment separate from custom SSR environments', async () => {
		await using fixture = await createDiskFixture()
		let customSsrCreated = false
		await withTestViteServer(
			{
				root: fixture.path,
				environments: {
					ssr: {
						dev: {
							createEnvironment(name, config) {
								customSsrCreated = true
								return createRunnableDevEnvironment(name, config)
							},
						},
					},
				},
			},
			async (server) => {
				expect(customSsrCreated).toBe(true)
				expect(server.environments.client.config.consumer).toBe('client')
				expect(getHostModuleRunner(server)).toBe(
					(server.environments[HOST_VITE_ENVIRONMENT] as RunnableDevEnvironment).runner,
				)
				expect(server.environments.ssr).not.toBe(server.environments[HOST_VITE_ENVIRONMENT])
			},
		)
		await expect(
			createTestViteServer({
				root: fixture.path,
				environments: {
					[HOST_VITE_ENVIRONMENT]: {
						dev: {
							createEnvironment: () => {
								throw new Error('must not run')
							},
						},
					},
				},
			}),
		).rejects.toThrow(/owned by host/)
	})

	it('resolves source aliases and CommonJS through Vite while keeping Node imports out of browsers', async () => {
		await using fixture = await createDiskFixture()
		const root = fixture.path
		const entryPath = join(root, 'entry.ts')
		await mkdir(join(root, 'commonjs'))
		await writeFile(
			join(root, 'commonjs/index.cjs'),
			"const { basename } = require('node:path'); module.exports = { answer: 42, name: basename('/fixture/value') }\n",
		)
		await writeFile(
			join(root, 'tsconfig.json'),
			JSON.stringify({
				include: ['**/*'],
				compilerOptions: {
					baseUrl: '.',
					paths: {
						'local-value': ['./value.ts'],
						'local-commonjs': ['./commonjs/index.cjs'],
					},
				},
			}),
		)
		await writeFile(join(root, 'value.ts'), 'export const increment: number = 1\n')
		await writeFile(
			join(root, 'browser-path.ts'),
			'export const basename = (value: string) => value\n',
		)
		await writeFile(
			join(root, 'browser.ts'),
			"import { basename } from 'node:path'; export const name = basename('/value')\n",
		)
		await writeFile(
			entryPath,
			"import value from 'local-commonjs'\nimport { increment } from 'local-value'\nimport { basename } from 'node:path'\nexport const answer: number = value.answer + increment\nexport const name = basename('/fixture/' + value.name)\n",
		)

		for (const packageMode of ['development', 'distribution'] as const) {
			await withTestViteServer(
				{
					root,
					plugins: [
						{
							name: 'test:early-host-consumer',
							enforce: 'pre',
							async configureServer(server) {
								const mod = await getHostModuleRunner(server).import<{
									answer: number
									name: string
								}>(entryPath)
								expect(mod.answer).toBe(43)
								expect(mod.name).toBe('value')
							},
						},
						...hostSourcePlugins({
							packageMode,
							lintGuard: false,
							configSource: false,
						}),
					],
				},
				async (server) => {
					const mod = await importHostModule<{ answer: number; name: string }>(server, entryPath)
					expect(mod.answer).toBe(43)
					expect(mod.name).toBe('value')
					await expect(server.environments.client.transformRequest('/browser.ts')).rejects.toThrow(
						/Node-only import.*node:path.*browser.ts/,
					)
				},
			)
		}
		await withTestViteServer(
			{
				root,
				resolve: { tsconfigPaths: false, alias: { 'node:path': join(root, 'browser-path.ts') } },
				plugins: hostSourcePlugins({ lintGuard: false, configSource: false }),
			},
			async (server) => {
				await expect(importHostModule(server, entryPath)).rejects.toThrow(/local-commonjs/)
				const browser = await server.environments.client.transformRequest('/browser.ts')
				expect(browser?.code).toContain('/browser-path.ts')
			},
		)
	})

	it('loads SSR modules through the source-map aware Vite module runner', async () => {
		await using fixture = await createDiskFixture()
		const root = fixture.path
		const modulePath = join(root, 'probe.ts')
		await writeFile(
			modulePath,
			['export function captureStack() {', "  return new Error('probe').stack", '}', ''].join('\n'),
		)

		await withTestViteServer({ root }, async (server) => {
			const mod = await importHostModule<{ captureStack(): string }>(server, modulePath)

			expect(mod.captureStack()).toMatch(/probe\.ts:2:\d+/)
			await writeFile(modulePath, "export function captureStack() { return 'updated' }\n")
			invalidateHostModuleGraphFiles(server, [modulePath])
			invalidateHostModule(server, modulePath)
			const updated = await importHostModule<{ captureStack(): string }>(server, modulePath)
			expect(updated.captureStack()).toBe('updated')
		})
	})

	it('owns one SSR runner per Vite server and closes it with the server', async () => {
		await using fixture = await createDiskFixture()
		const root = fixture.path
		let runner: ReturnType<typeof getHostModuleRunner> | undefined
		let runnerOpenDuringCloseBundle = false
		const server = await createTestViteServer({
			root,
			plugins: [
				{
					name: 'test:runner-close-order',
					closeBundle() {
						runnerOpenDuringCloseBundle = Boolean(runner && !runner.isClosed())
					},
				},
			],
		})
		const first = getHostModuleRunner(server)
		runner = first
		const second = getHostModuleRunner(server)
		expect(second).toBe(first)
		await server.close()
		expect(runnerOpenDuringCloseBundle).toBe(true)
		expect(first.isClosed()).toBe(true)
		await server.close()
	})

	it('lowers root and PluginPart constructor dependencies through the Vite Module Runner', async () => {
		await using fixture = await createDiskFixture({}, { tempDir: process.cwd() })
		const root = fixture.path
		const modulePath = join(root, 'plugin.ts')
		await writePackage(
			root,
			'@pluxel/core',
			{
				name: '@pluxel/core',
				type: 'module',
				exports: {
					'.': './index.js',
					'./internal': './internal.js',
					'./toolchain': './toolchain.js',
				},
			},
			[
				"import { addresses } from './state.js'",
				'export class BasePlugin {}',
				'export class PluginPart {}',
				'export function Plugin() { return (target) => target }',
				'export function pluginDefinitionAddressOf(target) { const value = addresses.get(target); if (!value) throw new Error("missing address"); return value }',
			].join('\n'),
		)
		await Promise.all([
			writeFile(
				join(root, 'node_modules', '@pluxel/core', 'state.js'),
				[
					'export const facts = new WeakMap()',
					'export const addresses = new WeakMap()',
					'export const partRequires = new WeakMap()',
					'export const partOccurrences = new WeakMap()',
					'',
				].join('\n'),
			),
			writeFile(
				join(root, 'node_modules', '@pluxel/core', 'toolchain.js'),
				[
					"import { addresses, facts, partOccurrences, partRequires } from './state.js'",
					'export function __setPluginDefinition(target, value) { facts.set(target, value); addresses.set(target, value.definition) }',
					'export function __setPluginParts(target, value) { partOccurrences.set(target, value.occurrences) }',
					'export function __setPluginPartRequires(target, value) { partRequires.set(target, value.requires) }',
				].join('\n'),
			),
			writeFile(
				join(root, 'node_modules', '@pluxel/core', 'internal.js'),
				[
					"import { facts, partOccurrences, partRequires } from './state.js'",
					'function collectPartRequires(owner, output) { for (const occurrence of partOccurrences.get(owner) ?? []) { output.push(...(partRequires.get(occurrence.Part) ?? [])); collectPartRequires(occurrence.Part, output) } }',
					'export function consumePluginDefinitionCandidate(target) { const value = facts.get(target); if (!value) throw new Error("missing candidate"); facts.delete(target); const constructorRequires = value.constructorRequires ?? []; const lifted = [...constructorRequires]; collectPartRequires(target, lifted); const seen = new Set(); const requires = lifted.filter((item) => { const key = JSON.stringify(item); if (seen.has(key)) return false; seen.add(key); return true }); return { implementation: target, declaration: { address: value.definition, constructorRequires, requires } } }',
				].join('\n'),
			),
		])
		await writeFile(
			modulePath,
			[
				"import { BasePlugin, pluginDefinitionAddressOf, Plugin, PluginPart } from '@pluxel/core'",
				"import { consumePluginDefinitionCandidate } from '@pluxel/core/internal'",
				'@Plugin()',
				'export class Provider extends BasePlugin {}',
				'@Plugin()',
				'export class Consumer extends BasePlugin { constructor(readonly provider: Provider) { super() } }',
				'class ProviderPart extends PluginPart<PartConsumer> { constructor(readonly provider: Provider) { super() } }',
				'@Plugin()',
				'export class PartConsumer extends BasePlugin { readonly first = this.parts.use(ProviderPart); readonly second = this.parts.use(ProviderPart) }',
				'export function providerDefinition() { return pluginDefinitionAddressOf(Provider) }',
				'export function consumerRequires() { return consumePluginDefinitionCandidate(Consumer).declaration.requires }',
				'export function partConsumerFacts() { return consumePluginDefinitionCandidate(PartConsumer).declaration }',
				'',
			].join('\n'),
		)

		await withTestViteServer(
			{
				root,
				plugins: hostSourcePlugins({ lintGuard: false, configSource: false }),
			},
			async (server) => {
				const mod = await importHostModule<{
					providerDefinition(): {
						entry: { kind: string; sourceSpace: string; path: string }
						exportName: string
					}
					consumerRequires(): unknown[]
					partConsumerFacts(): { constructorRequires: unknown[]; requires: unknown[] }
				}>(server, modulePath)
				expect(mod.providerDefinition()).toEqual({
					entry: { kind: 'source-entry', sourceSpace: 'app', path: 'plugin.ts' },
					exportName: 'Provider',
				})
				expect(mod.consumerRequires()).toEqual([mod.providerDefinition()])
				expect(mod.partConsumerFacts()).toMatchObject({
					constructorRequires: [],
					requires: [mod.providerDefinition()],
				})
			},
		)
	})
})

async function writePackage(
	root: string,
	name: string,
	manifest: Record<string, unknown>,
	source = 'export default true\n',
) {
	const packageRoot = join(root, 'node_modules', name)
	await mkdir(packageRoot, { recursive: true })
	await Promise.all([
		writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest)),
		writeFile(join(packageRoot, 'index.js'), source),
	])
}
