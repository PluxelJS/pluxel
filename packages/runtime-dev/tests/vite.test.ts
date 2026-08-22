import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { describe, expect, it } from 'vitest'
import { createServer, type InlineConfig, type Plugin, type ViteDevServer } from 'vite'
import { pluxelRuntimeSourceVitePlugins } from '@pluxel/rolldown/vite'

import {
	createHostModuleClassifier,
	createHostModuleVitePlugin,
	createWorkbenchViteClientConfig,
	getPluxelViteSsrModuleRunner,
	importViteSsrModule,
} from '../src/vite'

function createTestViteServer(config: InlineConfig): Promise<ViteDevServer> {
	return createServer({
		logLevel: 'silent',
		server: { middlewareMode: true },
		appType: 'custom',
		optimizeDeps: { noDiscovery: true, include: [] },
		...config,
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

describe('runtime-dev Vite plugin stack', () => {
	it('declares the Workbench client graph before optimizer startup', () => {
		expect(createWorkbenchViteClientConfig('/@fs/workspace/workbench/client.tsx')).toEqual({
			optimizeDeps: {
				entries: ['/workspace/workbench/client.tsx'],
				include: [
					'@tabler/icons-react',
					'@pluxel/runtime > @elysiajs/eden',
					'@pluxel/runtime > capnweb',
				],
				noDiscovery: false,
				holdUntilCrawlEnd: true,
				ignoreOutdatedRequests: true,
			},
		})
	})

	it('exposes source/server semantics as a dedicated plugin', () => {
		const plugins = pluxelRuntimeSourceVitePlugins() as Plugin[]
		const plugin = plugins.at(-1)!
		const config = plugin.config?.({} as never, { command: 'serve', mode: 'development' }) as {
			resolve?: { conditions?: string[]; externalConditions?: string[]; dedupe?: string[] }
			ssr?: {
				external?: string[]
				resolve?: { conditions?: string[]; externalConditions?: string[] }
			}
			oxc?: { decorator?: { legacy?: boolean; emitDecoratorMetadata?: boolean } }
		}

		expect(plugin.name).toBe('pluxel:runtime-source')
		expect(config.resolve?.conditions?.slice(0, 3)).toEqual([
			'@pluxel/hmr',
			'development',
			'@pluxel/source',
		])
		expect(config.ssr?.resolve?.conditions).toEqual(
			expect.arrayContaining(['@pluxel/source', 'node', 'import', 'default']),
		)
		expect(config.resolve?.externalConditions).not.toContain('@pluxel/source')
		expect(config.resolve?.externalConditions).toEqual(['node', 'import', 'default'])
		expect(config.ssr?.resolve?.externalConditions).toEqual(['node', 'import', 'default'])
		expect(config.resolve?.dedupe).toEqual(expect.arrayContaining(['@pluxel/runtime']))
		expect(config.resolve?.dedupe).not.toContain('@pluxel/core')
		expect(config.ssr?.external).toEqual(expect.arrayContaining(['@pluxel/runtime']))
		expect(config.ssr?.external).toContain('@pluxel/core')
		expect(config.oxc?.decorator?.legacy).toBe(true)
		expect(config.oxc?.decorator?.emitDecoratorMetadata).toBe(false)
	})

	it('leaves distribution bare packages to the Node host', () => {
		const plugins = pluxelRuntimeSourceVitePlugins({ packageMode: 'distribution' }) as Plugin[]
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
				plugins: pluxelRuntimeSourceVitePlugins({ lintGuard: false, configSource: false }),
			},
			async (server) => {
				const mod = await importViteSsrModule<{ branch: string }>(server, modulePath)
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
				plugins: pluxelRuntimeSourceVitePlugins({
					lintGuard: false,
					configSource: false,
				}),
			},
			async (server) => {
				const mod = await importViteSsrModule<{ selected: string }>(server, entryPath)
				expect(mod.selected).toBe('node')
			},
		)
	})

	it('classifies CommonJS and native packages for Node externalization', async () => {
		await using fixture = await createDiskFixture()
		const root = fixture.path
		await Promise.all([
			writePackage(root, 'fixture-commonjs', { type: 'commonjs', main: './index.js' }),
			writePackage(root, 'fixture-native', { type: 'module', napi: { name: 'fixture-native' } }),
			writePackage(root, 'fixture-esm', { type: 'module', main: './index.js' }),
		])
		const classifier = createHostModuleClassifier({ root })
		expect(
			await Promise.all([
				classifier.classifySpecifier('fixture-commonjs'),
				classifier.classifySpecifier('fixture-native'),
				classifier.classifySpecifier('fixture-esm'),
			]),
		).toEqual([
			expect.objectContaining({ format: 'commonjs', reason: 'commonjs' }),
			expect.objectContaining({ reason: 'native' }),
			null,
		])
	})

	it('prefers the ESM side of dual import/require exports in the real Vite runner', async () => {
		await using fixture = await createDiskFixture()
		const root = fixture.path
		const entryPath = join(root, 'entry.ts')
		await writePackage(root, 'fixture-dual', {
			name: 'fixture-dual',
			type: 'module',
			exports: { import: './index.mjs', require: './index.cjs' },
		})
		await Promise.all([
			writeFile(join(root, 'node_modules', 'fixture-dual', 'index.mjs'), 'export default 42\n'),
			writeFile(
				join(root, 'node_modules', 'fixture-dual', 'index.cjs'),
				"throw new Error('CJS entry must not be evaluated')\n",
			),
			writeFile(entryPath, "import answer from 'fixture-dual'\nexport { answer }\n"),
		])

		await withTestViteServer(
			{
				root,
				plugins: [createHostModuleVitePlugin()],
			},
			async (server) => {
				const mod = await importViteSsrModule<{ answer: number }>(server, entryPath)
				expect(mod.answer).toBe(42)
			},
		)
	})

	it('applies host-module externalization only to server environments', async () => {
		const plugin = createHostModuleVitePlugin()
		const server = await plugin.applyToEnvironment?.({
			name: 'ssr',
			config: { consumer: 'server' },
		} as never)
		const client = await plugin.applyToEnvironment?.({
			name: 'client',
			config: { consumer: 'client' },
		} as never)
		expect(server).toBe(true)
		expect(client).toBe(false)
		await plugin.configResolved?.({ root: '/repo' } as never)
		expect(
			plugin.resolveId?.('./workspace-source.ts', undefined, { ssr: true } as never),
		).toBeNull()
	})

	it('loads CommonJS from Node while transforming distribution source entries', async () => {
		await using fixture = await createDiskFixture()
		const root = fixture.path
		const entryPath = join(root, 'entry.ts')
		await writePackage(
			root,
			'fixture-commonjs',
			{ name: 'fixture-commonjs', type: 'commonjs', main: './index.js' },
			'module.exports = { answer: 42 }\n',
		)
		await writeFile(
			entryPath,
			"import value from 'fixture-commonjs'\nexport const answer: number = value.answer\n",
		)

		await withTestViteServer(
			{
				root,
				plugins: pluxelRuntimeSourceVitePlugins({
					packageMode: 'distribution',
					lintGuard: false,
					configSource: false,
				}),
			},
			async (server) => {
				const mod = await importViteSsrModule<{ answer: number }>(server, entryPath)
				expect(mod.answer).toBe(42)
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
			const mod = await importViteSsrModule<{ captureStack(): string }>(server, modulePath)

			expect(mod.captureStack()).toMatch(/probe\.ts:2:\d+/)
		})
	})

	it('owns one SSR runner per Vite server and closes it with the server', async () => {
		await using fixture = await createDiskFixture()
		const root = fixture.path
		let runner: ReturnType<typeof getPluxelViteSsrModuleRunner> | undefined
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
		const first = getPluxelViteSsrModuleRunner(server)
		runner = first
		const second = getPluxelViteSsrModuleRunner(server)
		expect(second).toBe(first)
		await server.close()
		expect(runnerOpenDuringCloseBundle).toBe(true)
		expect(first.isClosed()).toBe(true)
		await server.close()
	})

	it('lowers constructor dependencies into explicit Plugin definition facts', async () => {
		await using fixture = await createDiskFixture({}, { tempDir: process.cwd() })
		const root = fixture.path
		const modulePath = join(root, 'plugin.ts')
		await writePackage(
			root,
			'@pluxel/runtime',
			{
				name: '@pluxel/runtime',
				type: 'module',
				exports: './index.js',
			},
			[
				'const facts = new WeakMap()',
				'export class BasePlugin {}',
				'export function Plugin() { return (target) => target }',
				'export function __setPluginDefinition(target, value) { facts.set(target, value) }',
				'export function getPluginDefinitionFacts(target) { const value = facts.get(target); if (!value) throw new Error("missing facts"); return value }',
			].join('\n'),
		)
		await writeFile(
			modulePath,
			[
				"import { BasePlugin, getPluginDefinitionFacts, Plugin } from '@pluxel/runtime'",
				'@Plugin()',
				'export class Provider extends BasePlugin {}',
				'@Plugin()',
				'export class Consumer extends BasePlugin { constructor(readonly provider: Provider) { super() } }',
				'export function providerDefinition() { return getPluginDefinitionFacts(Provider).definition }',
				'export function consumerRequires() { return getPluginDefinitionFacts(Consumer).requires }',
				'',
			].join('\n'),
		)

		await withTestViteServer(
			{
				root,
				plugins: pluxelRuntimeSourceVitePlugins({ lintGuard: false, configSource: false }),
			},
			async (server) => {
				const mod = await importViteSsrModule<{
					providerDefinition(): {
						entry: { kind: string; sourceSpace: string; path: string }
						exportName: string
					}
					consumerRequires(): unknown[]
				}>(server, modulePath)
				expect(mod.providerDefinition()).toEqual({
					entry: { kind: 'source-entry', sourceSpace: 'app', path: 'plugin.ts' },
					exportName: 'Provider',
				})
				expect(mod.consumerRequires()).toEqual([mod.providerDefinition()])
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
