import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ConcretePluginDefinitionDeclaration } from '@pluxel/core/internal'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { describe, expect, it } from 'vitest'
import {
	createServer,
	createRunnableDevEnvironment,
	type RunnableDevEnvironment,
	type InlineConfig,
	type ViteDevServer,
} from 'vite'
import { createPluginSourceVitePipeline } from '@pluxel/rolldown/vite'

import { host, hostSingletons } from '../src/index'
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

describe('host-vite Vite plugin stack', () => {
	it('rejects unknown Host options rather than silently ignoring misspelled configuration', () => {
		const options = { entry: 'app.ts', devConsol: true }
		expect(() => host(options)).toThrow('[host-vite] unsupported devConsol')
		expect(() => host({ entry: 'app.ts', onUpdateSettled: null })).toThrow(
			'[host-vite] onUpdateSettled must be a function',
		)
	})

	it('pins selected service entries to their native application installation', async () => {
		await using fixture = await createDiskFixture()
		const root = fixture.path
		await writePackage(
			root,
			'@acme/services',
			{
				name: '@acme/services',
				version: '1.0.0',
				type: 'module',
				exports: {
					'./commands': './index.js',
					'./fs': './index.js',
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
					'@acme/services/fs',
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

	it('fixes shared package selection before callers mutate the declaration', async () => {
		await using fixture = await createDiskFixture()
		const root = fixture.path
		for (const name of ['fixture-shared', 'fixture-unselected'])
			await writePackage(
				root,
				name,
				{ name, version: '1.0.0', type: 'module', exports: './index.js' },
				'export const token = {}',
			)
		const packages = ['fixture-shared']
		const singletons = hostSingletons({ packages })
		packages.length = 0
		const entry = join(root, 'entry.ts')
		const lateEntry = join(root, 'late.ts')
		await writeFile(entry, "export { token } from 'fixture-shared'")
		await writeFile(lateEntry, "export { token } from 'fixture-unselected'")
		const sharedNative = await import(
			/* @vite-ignore */ pathToFileURL(join(root, 'node_modules/fixture-shared/index.js')).href
		)
		const unselectedNative = await import(
			/* @vite-ignore */ pathToFileURL(join(root, 'node_modules/fixture-unselected/index.js')).href
		)
		await withTestViteServer(
			{
				root,
				environments: { [HOST_VITE_ENVIRONMENT]: { resolve: { noExternal: true } } },
				plugins: [singletons],
			},
			async (server) => {
				const shared = await importHostModule<{ token: object }>(server, entry)
				expect(shared.token).toBe(sharedNative.token)
				packages.push('fixture-unselected')
				const unselected = await importHostModule<{ token: object }>(server, lateEntry)
				expect(unselected.token).not.toBe(unselectedNative.token)
			},
		)
	})

	it('preprocesses distribution ESM packages inside the real Vite module graph', async () => {
		await using fixture = await createDiskFixture({}, { tempDir: process.cwd() })
		const root = fixture.path
		const modulePath = join(root, 'plugin.ts')
		await writePackage(
			root,
			'fixture-distribution',
			{
				name: 'fixture-distribution',
				type: 'module',
				exports: { '@pluxel/source': './source.js', default: './index.js' },
			},
			"export const selected = 'distribution'\n",
		)
		await writeFile(
			join(root, 'node_modules/fixture-distribution/source.js'),
			"export const selected = 'source'\n",
		)
		await writeFile(
			modulePath,
			[
				"export { selected } from 'fixture-distribution'",
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
				plugins: hostSourcePlugins({
					packageMode: 'distribution',
					lintGuard: false,
					configSource: false,
				}),
			},
			async (server) => {
				const mod = await importHostModule<{ branch: string; selected: string }>(server, modulePath)
				expect(mod.branch).toBe('included')
				expect(mod.selected).toBe('distribution')
				expect(
					server.environments[HOST_VITE_ENVIRONMENT]!.moduleGraph.getModuleById(
						join(root, 'node_modules/fixture-distribution/index.js'),
					),
				).toBeDefined()
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

	it('rejects a broken nearest package manifest instead of inheriting the parent type', async () => {
		await using fixture = await createDiskFixture()
		const root = fixture.path
		const packageRoot = join(root, 'node_modules', 'fixture-broken')
		await mkdir(packageRoot, { recursive: true })
		await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
		await writeFile(join(packageRoot, 'package.json'), '{broken')
		const entry = join(packageRoot, 'index.js')
		await writeFile(entry, 'module.exports = true\n')
		await expect(createHostModuleClassifier().classifyFile(entry)).rejects.toThrow(
			join(packageRoot, 'package.json'),
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

	it('loads real constructor and Part dependency facts through the Vite Module Runner', async () => {
		await using fixture = await createDiskFixture({
			'package.json': '{ "type": "module" }',
			'optional.ts': `
import { BasePlugin, Plugin } from '@pluxel/core'
@Plugin() export class Audit extends BasePlugin {}
`,
			'plugin.ts': `
import { BasePlugin, definePluginRef, Plugin, PluginPart } from '@pluxel/core'
import { consumePluginDefinitionCandidate } from '@pluxel/core/internal'
import type { Audit } from './optional'
const AuditRef = definePluginRef<Audit>()
@Plugin() export class Provider extends BasePlugin {}
class Leaf extends PluginPart<Branch> {
	constructor(readonly provider: Provider) { super() }
	init() { this.plugins.use(AuditRef, () => {}) }
}
class Branch extends PluginPart<Consumer> { readonly leaf = this.parts.use(Leaf) }
@Plugin() export class Consumer extends BasePlugin {
	constructor(readonly provider: Provider) { super() }
	readonly first = this.parts.use(Branch)
	readonly second = this.parts.use(Branch)
}
export function readDeclaration() { return consumePluginDefinitionCandidate(Consumer).declaration }
`,
		})
		const scope = fixture.getPath('node_modules/@pluxel')
		await mkdir(scope, { recursive: true })
		await symlink(fileURLToPath(new URL('../../core', import.meta.url)), join(scope, 'core'), 'dir')

		await withTestViteServer(
			{
				root: fixture.path,
				plugins: [hostSingletons(), ...hostSourcePlugins({ lintGuard: false })],
			},
			async (server) => {
				const { readDeclaration } = await importHostModule<{
					readDeclaration(): ConcretePluginDefinitionDeclaration
				}>(server, fixture.getPath('plugin.ts'))
				const declaration = readDeclaration()
				const provider = {
					entry: { kind: 'source-entry', sourceSpace: 'app', path: 'plugin.ts' },
					exportName: 'Provider',
				}
				const audit = {
					entry: { kind: 'source-entry', sourceSpace: 'app', path: 'optional.ts' },
					exportName: 'Audit',
				}
				expect(declaration).toMatchObject({
					constructorRequires: [provider],
					requires: [provider],
					optional: [audit],
				})
				expect(declaration.dependencyRequests).toEqual([
					{ definition: provider, mode: 'required', partPath: [] },
					{ definition: provider, mode: 'required', partPath: ['first', 'leaf'] },
					{ definition: audit, mode: 'optional', partPath: ['first', 'leaf'] },
					{ definition: provider, mode: 'required', partPath: ['second', 'leaf'] },
					{ definition: audit, mode: 'optional', partPath: ['second', 'leaf'] },
				])
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
