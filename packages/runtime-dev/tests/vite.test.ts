import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createServer, type Plugin } from 'vite'
import { pluxelRuntimeSourceVitePlugins } from '@pluxel/rolldown/vite'

import {
	createHostModuleClassifier,
	createHostModuleVitePlugin,
	createWorkbenchViteClientConfig,
	getPluxelViteSsrModuleRunner,
	importViteSsrModule,
} from '../src/vite'

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
		expect(config.oxc?.decorator?.emitDecoratorMetadata).toBe(true)
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

	it('exposes one source plugin group with server-only transforms', async () => {
		const plugins = pluxelRuntimeSourceVitePlugins({
			root: '/repo',
		}) as Plugin[]

		expect(plugins.map((plugin) => plugin.name)).toEqual([
			'unplugin-preprocessor-directives',
			'pluxel:database-source',
			'pluxel:plugin-semantics',
			'pluxel-lint-guard',
			'pluxel-config-source',
			'pluxel:runtime-source',
		])
		for (const plugin of plugins.slice(1, -1)) {
			const server = await plugin.applyToEnvironment?.({
				name: 'ssr',
				config: { consumer: 'server' },
			} as never)
			const client = await plugin.applyToEnvironment?.({
				name: 'client',
				config: { consumer: 'client' },
			} as never)
			expect(server).not.toBe(false)
			expect(client).toBe(false)
		}
	})

	it('applies preprocessor semantics through the real Vite module runner', async () => {
		const root = await mkdtemp(join(process.cwd(), '.pluxel-runtime-dev-source-pipeline-'))
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

		let server: ViteDevServer | undefined
		try {
			server = await createServer({
				root,
				logLevel: 'silent',
				server: { middlewareMode: true },
				appType: 'custom',
				plugins: pluxelRuntimeSourceVitePlugins({ lintGuard: false, configSource: false }),
			})
			const mod = await importViteSsrModule<{ branch: string }>(server, modulePath)
			expect(mod.branch).toBe('included')
		} finally {
			await server?.close()
			await rm(root, { recursive: true, force: true })
		}
	})

	it('uses Node conditions for external packages in the real Vite runner', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-node-external-conditions-'))
		const entryPath = join(root, 'entry.ts')
		try {
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

			let server: ViteDevServer | undefined
			try {
				server = await createServer({
					root,
					logLevel: 'silent',
					server: { middlewareMode: true },
					appType: 'custom',
					plugins: pluxelRuntimeSourceVitePlugins({ lintGuard: false, configSource: false }),
				})
				const mod = await importViteSsrModule<{ selected: string }>(server, entryPath)
				expect(mod.selected).toBe('node')
			} finally {
				await server?.close()
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('classifies CommonJS and native packages without externalization config', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-host-modules-'))
		try {
			await writePackage(root, 'fixture-commonjs', {
				name: 'fixture-commonjs',
				type: 'commonjs',
				main: './index.js',
			})
			await writePackage(root, 'fixture-native', {
				name: 'fixture-native',
				type: 'module',
				main: './index.js',
				napi: { name: 'fixture-native' },
			})
			await writePackage(root, 'fixture-esm', {
				name: 'fixture-esm',
				type: 'module',
				main: './index.js',
			})
			await writePackage(root, 'fixture-dual', {
				name: 'fixture-dual',
				type: 'module',
				exports: { import: './index.mjs', require: './index.cjs' },
			})
			await Promise.all([
				writeFile(join(root, 'node_modules', 'fixture-dual', 'index.mjs'), 'export default 42\n'),
				writeFile(join(root, 'node_modules', 'fixture-dual', 'index.cjs'), 'module.exports = 42\n'),
			])
			const explicitCommonjs = join(root, 'node_modules', 'fixture-esm', 'explicit.cjs')
			const explicitNative = join(root, 'node_modules', 'fixture-esm', 'binding.node')
			await Promise.all([writeFile(explicitCommonjs, ''), writeFile(explicitNative, '')])

			const classifier = createHostModuleClassifier({ root })
			await expect(classifier.classifySpecifier('fixture-commonjs')).resolves.toMatchObject({
				packageName: 'fixture-commonjs',
				format: 'commonjs',
				reason: 'commonjs',
			})
			await expect(classifier.classifySpecifier('fixture-native')).resolves.toMatchObject({
				packageName: 'fixture-native',
				format: 'module',
				reason: 'native',
			})
			await expect(classifier.classifySpecifier('fixture-esm')).resolves.toBeNull()
			await expect(classifier.classifySpecifier('fixture-dual')).resolves.toBeNull()
			await expect(classifier.classifyFile(explicitCommonjs)).resolves.toMatchObject({
				format: 'commonjs',
				reason: 'commonjs',
			})
			await expect(classifier.classifyFile(explicitNative)).resolves.toMatchObject({
				format: 'commonjs',
				reason: 'native',
			})
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('prefers the ESM side of dual import/require exports in the real Vite runner', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-host-module-dual-'))
		const entryPath = join(root, 'entry.ts')
		try {
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

			let server: ViteDevServer | undefined
			try {
				server = await createServer({
					root,
					logLevel: 'silent',
					server: { middlewareMode: true },
					appType: 'custom',
					plugins: [createHostModuleVitePlugin()],
				})
				const mod = await importViteSsrModule<{ answer: number }>(server, entryPath)
				expect(mod.answer).toBe(42)
			} finally {
				await server?.close()
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
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

	it('loads a zero-config CommonJS package through the real Vite SSR runner', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-host-module-vite-'))
		const entryPath = join(root, 'entry.ts')
		try {
			await writePackage(
				root,
				'fixture-commonjs',
				{ name: 'fixture-commonjs', type: 'commonjs', main: './index.js' },
				'module.exports = { answer: 42 }\n',
			)
			await writeFile(
				entryPath,
				"import value from 'fixture-commonjs'\nexport const answer = value.answer\n",
			)

			let server: ViteDevServer | undefined
			try {
				server = await createServer({
					root,
					logLevel: 'silent',
					server: { middlewareMode: true },
					appType: 'custom',
					plugins: [createHostModuleVitePlugin()],
				})
				const mod = await importViteSsrModule<{ answer: number }>(server, entryPath)
				expect(mod.answer).toBe(42)
			} finally {
				await server?.close()
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('loads CommonJS from Node while transforming distribution source entries', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-distribution-host-module-vite-'))
		const entryPath = join(root, 'entry.ts')
		try {
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

			let server: ViteDevServer | undefined
			try {
				server = await createServer({
					root,
					logLevel: 'silent',
					server: { middlewareMode: true },
					appType: 'custom',
					plugins: pluxelRuntimeSourceVitePlugins({
						packageMode: 'distribution',
						lintGuard: false,
						configSource: false,
					}),
				})
				const mod = await importViteSsrModule<{ answer: number }>(server, entryPath)
				expect(mod.answer).toBe(42)
			} finally {
				await server?.close()
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('loads SSR modules through the source-map aware Vite module runner', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-runtime-dev-'))
		const modulePath = join(root, 'probe.ts')
		await writeFile(
			modulePath,
			['export function captureStack() {', "  return new Error('probe').stack", '}', ''].join('\n'),
		)

		let server: ViteDevServer | undefined
		try {
			server = await createServer({
				root,
				logLevel: 'silent',
				server: { middlewareMode: true },
				appType: 'custom',
			})
			const mod = await importViteSsrModule<{ captureStack(): string }>(server, modulePath)

			expect(mod.captureStack()).toMatch(/probe\.ts:2:\d+/)
		} finally {
			await server?.close()
			await rm(root, { recursive: true, force: true })
		}
	})

	it('owns one SSR runner per Vite server and closes it with the server', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-runtime-dev-runner-owner-'))
		let runner: ReturnType<typeof getPluxelViteSsrModuleRunner> | undefined
		let runnerOpenDuringCloseBundle = false
		const server = await createServer({
			root,
			logLevel: 'silent',
			server: { middlewareMode: true },
			appType: 'custom',
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
		await rm(root, { recursive: true, force: true })
	})

	it('emits constructor dependency metadata through the real Vite module runner', async () => {
		const root = await mkdtemp(join(process.cwd(), '.pluxel-runtime-dev-metadata-'))
		const modulePath = join(root, 'plugin.ts')
		await writeFile(
			modulePath,
			[
				'const metadata = new WeakMap<object, Map<string, unknown>>()',
				';(Reflect as any).metadata = (key: string, value: unknown) => (target: object) => { const values = metadata.get(target) ?? new Map(); values.set(key, value); metadata.set(target, values) }',
				';(Reflect as any).getMetadata = (key: string, target: object) => metadata.get(target)?.get(key)',
				'function Plugin(): ClassDecorator { return () => {} }',
				'export class Provider {}',
				'@Plugin()',
				'export class Consumer { constructor(readonly provider: Provider) {} }',
				"export const params = Reflect.getMetadata('design:paramtypes', Consumer)",
				'',
			].join('\n'),
		)

		let server: ViteDevServer | undefined
		try {
			server = await createServer({
				root,
				logLevel: 'silent',
				server: { middlewareMode: true },
				appType: 'custom',
				plugins: pluxelRuntimeSourceVitePlugins({ lintGuard: false, configSource: false }),
			})
			const mod = await importViteSsrModule<{ Provider: unknown; params: unknown[] }>(
				server,
				modulePath,
			)
			expect(mod.params).toEqual([mod.Provider])
		} finally {
			await server?.close()
			await rm(root, { recursive: true, force: true })
		}
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
