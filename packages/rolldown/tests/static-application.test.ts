import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { traceNodeModules } from 'nf3'
import { describe, expect, it, vi } from 'vitest'

import { createPluginBuildPipeline, pluginPackage } from '../src/cli/plugin-build.ts'
import { staticApplication } from '../src/cli/static-application.ts'
import { readPublicElysiaSpecifiers } from '../src/cli/elysia-singleton.ts'
import { createPluginSourceVitePipeline } from '../src/vite/plugin-source.ts'

vi.mock('nf3', () => ({ traceNodeModules: vi.fn() }))

function pluginNames(config: { plugins?: unknown }): string[] {
	return (config.plugins as Array<{ name?: string } | null | undefined>)
		.filter((plugin): plugin is { name?: string } => Boolean(plugin))
		.map((plugin) => plugin.name ?? '')
}

describe('staticApplication', () => {
	it('exposes one standard plugin package preset and shared source pipeline', () => {
		const pipeline = createPluginBuildPipeline({ root: '/tmp/pluxel-plugin-package' })
		const config = pluginPackage({
			root: '/tmp/pluxel-plugin-package',
			packageMetadata: {
				packageJsonPath: '/tmp/pluxel-plugin-package/package.json',
				manifestField: 'pluxel',
				log: () => undefined,
			},
		})

		expect(pluginNames(config)).toEqual(pluginNames(pipeline))
		expect(pluginNames(config)).toEqual([
			'unplugin-preprocessor-directives',
			'pluxel:plugin-semantics',
			'unplugin-macros',
			'pluxel-lint-guard',
			'pluxel-config-source',
			'pluxel-plugin-artifact-build',
			'pluxel:decorator-output-guard',
		])
		expect(config.deps?.neverBundle).toEqual([/^@pluxel\//])
		expect(config.exports).toEqual({ devExports: '@pluxel/hmr' })
		expect(config.inputOptions?.transform?.decorator).toEqual({
			legacy: true,
			emitDecoratorMetadata: false,
		})
	})

	it('keeps semantic package metadata inside the plugin package preset', () => {
		const config = pluginPackage({
			root: '/tmp/pluxel-plugin-package',
			packageMetadata: {
				packageJsonPath: '/tmp/pluxel-plugin-package/package.json',
				manifestField: 'pluxel',
				log: () => undefined,
			},
		})
		expect(pluginNames(config).filter((name) => name === 'pluxel:plugin-semantics')).toHaveLength(1)
		expect(config.onSuccess).toBeTypeOf('function')
	})

	it('exposes one concrete Vite source pipeline and its sole semantic collector', () => {
		const pipeline = createPluginSourceVitePipeline({
			root: '/tmp/pluxel-plugin-source',
			lintGuard: false,
			configSource: false,
		})
		expect(pluginNames(pipeline)).toEqual([
			'unplugin-preprocessor-directives',
			'pluxel:database-source',
			'pluxel:plugin-semantics',
			'pluxel:runtime-source',
		])
		expect(pipeline.semantics.workbenchPlans).toBeTypeOf('function')
	})

	it('runs the final output guard after caller-supplied compiler plugins', () => {
		const pipeline = createPluginBuildPipeline({
			root: '/tmp/pluxel-plugin-package',
			additionalPlugins: [{ name: 'fixture:additional' }],
		})
		expect(pluginNames(pipeline).slice(-2)).toEqual([
			'fixture:additional',
			'pluxel:decorator-output-guard',
		])
	})

	it('builds Node applications with native residual tracing', () => {
		const config = staticApplication({
			cwd: '/tmp/pluxel-static-node',
			entry: './src/pluxel.static.ts',
			variant: 'headless',
			target: 'node',
			sourcemap: true,
			sourcemapExcludeSources: true,
			lint: false,
		})

		expect(config.platform).toBe('node')
		expect(config.target).toBe('node24')
		expect(pluginNames(config)).toContain('pluxel:nf3-externals')
		expect(pluginNames(config)).toContain('pluxel:decorator-output-guard')
		expect(pluginNames(config).indexOf('pluxel:static-elysia-singleton')).toBeLessThan(
			pluginNames(config).indexOf('unplugin-preprocessor-directives'),
		)
		expect(config.inputOptions?.transform?.decorator).toEqual({
			legacy: true,
			emitDecoratorMetadata: false,
		})
		expect(config.entry).toEqual({ app: 'pluxel:static-application-bootstrap' })
		expect(config.sourcemap).toBe(true)
		expect(config.outputOptions).toMatchObject({ sourcemapExcludeSources: true })
	})

	it('bridges every explicit public Elysia runtime export except package data', () => {
		expect([
			...readPublicElysiaSpecifiers({
				exports: {
					'.': './dist/index.mjs',
					'./type': './dist/type.mjs',
					'./websocket': './dist/websocket.mjs',
					'./package.json': './package.json',
					'./private/*': './dist/private/*.mjs',
				},
			}),
		]).toEqual(['elysia', 'elysia/type', 'elysia/websocket'])
	})

	it('resolves Elysia public entries through the Runtime-owned package', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-static-elysia-'))
		const runtimeManifest = join(root, 'runtime/package.json')
		const elysiaManifest = join(root, 'runtime/node_modules/elysia/package.json')
		const typeEntry = join(root, 'runtime/node_modules/elysia/dist/type/exports.mjs')
		const typeboxValueEntry = join(root, 'runtime/node_modules/typebox/build/value/index.mjs')
		const exactMirrorEntry = join(root, 'runtime/node_modules/exact-mirror/dist/index.mjs')
		try {
			await mkdir(dirname(elysiaManifest), { recursive: true })
			await writeFile(
				elysiaManifest,
				JSON.stringify({ exports: { '.': './dist/index.mjs', './type': './dist/type.mjs' } }),
			)
			const config = staticApplication({
				cwd: root,
				entry: './src/pluxel.static.ts',
				lint: false,
			})
			const plugin = (
				config.plugins as Array<{
					name?: string
					buildStart?: unknown
					resolveId?: unknown
				}>
			).find((candidate) => candidate?.name === 'pluxel:static-elysia-singleton')
			const resolve = vi.fn(async (id: string, importer: string | undefined) => {
				if (id === '@pluxel/runtime/package.json') return { id: runtimeManifest }
				if (id === 'elysia/package.json') return { id: elysiaManifest }
				if (id === 'elysia/type') return { id: typeEntry, external: true }
				if (id === 'typebox/value') return { id: typeboxValueEntry, external: true }
				if (id === 'exact-mirror') return { id: exactMirrorEntry, external: true }
				throw new Error(`Unexpected resolution: ${id} from ${importer}`)
			})
			const context = {
				resolve,
				error(message: string): never {
					throw new Error(message)
				},
			}
			await (plugin?.buildStart as ((this: typeof context) => Promise<void>) | undefined)?.call(
				context,
			)
			const resolveId = (plugin?.resolveId as { handler?: unknown } | undefined)?.handler as
				| ((
						this: typeof context,
						id: string,
						importer: string,
						options: object,
				  ) => Promise<unknown> | null)
				| undefined
			await expect(
				resolveId?.call(context, 'elysia/type', join(root, 'plugin.ts'), {}),
			).resolves.toEqual({ id: typeEntry, external: false })
			expect(
				resolveId?.call(context, 'elysia/package.json', join(root, 'plugin.ts'), {}),
			).toBeNull()
			await expect(
				resolveId?.call(context, 'typebox/value', join(root, 'plugin.ts'), {}),
			).resolves.toEqual({ id: typeboxValueEntry, external: false })
			await expect(
				resolveId?.call(context, 'exact-mirror', join(root, 'plugin.ts'), {}),
			).resolves.toEqual({ id: exactMirrorEntry, external: false })
			expect(resolve).toHaveBeenCalledWith('elysia/type', runtimeManifest, {
				skipSelf: true,
			})
			expect(resolve).toHaveBeenCalledWith('typebox/value', elysiaManifest, {
				skipSelf: true,
			})
			expect(resolve).toHaveBeenCalledWith('exact-mirror', elysiaManifest, {
				skipSelf: true,
			})
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('rejects an unknown launcher instead of silently opening a listener', () => {
		expect(() =>
			staticApplication({
				cwd: '/tmp/pluxel-static-invalid-launcher',
				entry: './src/pluxel.static.ts',
				launcher: 'invalid' as never,
			}),
		).toThrow('[static-application] launcher must be either node or fetch')
	})

	it('generates a namespace-based production bootstrap for default and product exports', async () => {
		const config = staticApplication({
			cwd: '/tmp/pluxel-static-node',
			entry: './src/pluxel.static.ts',
			variant: 'workbench',
			lint: false,
		})
		const plugin = (
			config.plugins as Array<{
				name?: string
				resolveId?: (id: string) => unknown
				load?: (id: string) => unknown
			}>
		).find((candidate) => candidate?.name === 'pluxel-static-application-entry')
		const resolved = plugin?.resolveId?.('pluxel:static-application-bootstrap')
		const source = String(await plugin?.load?.(String(resolved)))

		expect(resolved).toBe('\0pluxel:static-application-bootstrap')
		expect(source).toContain('import * as __pluxelHostModule')
		expect(source).toContain('/tmp/pluxel-static-node/src/pluxel.static.ts')
		expect(source).toContain('readHostProduct as __readHostProduct')
		expect(source.indexOf("import 'pluxel:static-elysia-wiring'")).toBeLessThan(
			source.indexOf("from '@pluxel/runtime/internal/static-host'"),
		)
		expect(source.indexOf("from '@pluxel/runtime/internal/static-host'")).toBeLessThan(
			source.indexOf('import * as __pluxelHostModule'),
		)
		expect(source).toContain('__pluxelHostModule.default')
		expect(source).toContain('product: __pluxelProduct')
	})

	it('statically wires every Elysia TypeBox runtime namespace before the user module', async () => {
		const config = staticApplication({
			cwd: '/tmp/pluxel-static-node',
			entry: './src/pluxel.static.ts',
			lint: false,
		})
		const plugin = (
			config.plugins as Array<{
				name?: string
				resolveId?: (id: string) => unknown
				load?: (id: string) => unknown
			}>
		).find((candidate) => candidate?.name === 'pluxel:static-elysia-singleton')
		const resolveId = (plugin?.resolveId as { handler?: (id: string) => unknown } | undefined)
			?.handler
		const resolved = await resolveId?.('pluxel:static-elysia-wiring')
		const source = String(await plugin?.load?.(String(resolved)))

		expect(resolved).toBe('\0pluxel:static-elysia-wiring')
		expect(source).toContain("from 'exact-mirror'")
		for (const specifier of [
			'typebox/compile',
			'typebox/schema',
			'typebox/system',
			'typebox/type',
			'typebox/value',
		]) {
			expect(source).toContain(`from '${specifier}'`)
		}
		expect(source).toContain('__setupTypebox({')
	})

	it('emits a fetch-only production bootstrap without a listener address', async () => {
		const config = staticApplication({
			cwd: '/tmp/pluxel-static-fetch',
			entry: './src/pluxel.static.ts',
			variant: 'workbench',
			launcher: 'fetch',
			lint: false,
		})
		const plugin = (
			config.plugins as Array<{
				name?: string
				resolveId?: (id: string) => unknown
				load?: (id: string) => unknown
			}>
		).find((candidate) => candidate?.name === 'pluxel-static-application-entry')
		const resolved = plugin?.resolveId?.('pluxel:static-application-bootstrap')
		const source = String(await plugin?.load?.(String(resolved)))

		expect(source).toContain('@pluxel/runtime-static/internal/fetch-workbench-application')
		expect(source).toContain('runStaticFetchWorkbenchApplication')
		expect(source).toContain('export const fetch = __pluxelStaticRuntime.fetch')
		expect(source).not.toContain('runStaticNodeApplication')
		expect(source).not.toContain('export const address')
	})

	it('keeps PostgreSQL on the Node residual boundary', async () => {
		const config = staticApplication({
			cwd: '/tmp/pluxel-static-node',
			entry: './src/pluxel.static.ts',
			variant: 'headless',
			target: 'node',
			lint: false,
		})
		const plugin = (config.plugins as Array<{ name?: string; resolveId?: unknown }>).find(
			(candidate) => candidate?.name === 'pluxel:nf3-externals',
		)
		const resolveId = plugin?.resolveId as
			| ((
					this: { resolve: ReturnType<typeof vi.fn> },
					id: string,
					importer: string,
					options: object,
			  ) => Promise<unknown>)
			| undefined
		const resolve = vi.fn(async () => ({ id: '/tmp/node_modules/pg/esm/index.mjs' }))

		await expect(
			resolveId?.call({ resolve }, 'pg', '/tmp/pluxel-static-node/src/app.ts', {}),
		).resolves.toMatchObject({ id: 'pg', external: true })
		expect(resolve).toHaveBeenCalledWith('pg', '/tmp/pluxel-static-node/src/app.ts', {})
	})

	it('lowers disabled managed database drivers to explicit absent modules', async () => {
		vi.mocked(traceNodeModules).mockClear()
		const config = staticApplication({
			cwd: '/tmp/pluxel-static-private-database',
			entry: './src/pluxel.static.ts',
			variant: 'headless',
			managedDatabaseDrivers: [],
			lint: false,
		})
		const plugin = (
			config.plugins as Array<{
				name?: string
				resolveId?: unknown
				load?: unknown
				writeBundle?: unknown
			}>
		).find((candidate) => candidate?.name === 'pluxel:nf3-externals')
		const resolveId = plugin?.resolveId as
			| ((
					this: { resolve: ReturnType<typeof vi.fn> },
					id: string,
					importer: string,
					options: object,
			  ) => Promise<unknown>)
			| undefined
		const load = plugin?.load as ((id: string) => string | null) | undefined
		const writeBundle = (
			plugin?.writeBundle as { handler?: (this: object) => Promise<void> } | undefined
		)?.handler
		const resolve = vi.fn()

		for (const [driver, entry, exportName] of [
			['pglite', '#pluxel/database-driver/pglite', 'createPgliteDatabaseAdapter'],
			['postgres', '#pluxel/database-driver/postgres', 'createPostgresDatabaseAdapter'],
		] as const) {
			const resolved = await resolveId?.call(
				{ resolve },
				entry,
				'/tmp/pluxel-static-private-database/src/app.ts',
				{},
			)
			expect(resolved).toBe(`\0pluxel:omitted-managed-database:${driver}`)
			const source = load?.(String(resolved))
			expect(source).toContain(`export async function ${exportName}()`)
			expect(source).toContain(`managed database driver \\"${driver}\\" is not included`)
		}
		await writeBundle?.call({})

		expect(resolve).not.toHaveBeenCalled()
		expect(traceNodeModules).not.toHaveBeenCalled()
	})

	it('still traces application-private driver imports when managed drivers are omitted', async () => {
		vi.mocked(traceNodeModules).mockClear()
		const config = staticApplication({
			cwd: '/tmp/pluxel-static-private-postgres',
			entry: './src/pluxel.static.ts',
			managedDatabaseDrivers: [],
			lint: false,
		})
		const plugin = (
			config.plugins as Array<{
				name?: string
				resolveId?: unknown
				writeBundle?: unknown
			}>
		).find((candidate) => candidate?.name === 'pluxel:nf3-externals')
		const resolveId = plugin?.resolveId as
			| ((
					this: { resolve: ReturnType<typeof vi.fn> },
					id: string,
					importer: string,
					options: object,
			  ) => Promise<unknown>)
			| undefined
		const writeBundle = (
			plugin?.writeBundle as { handler?: (this: object) => Promise<void> } | undefined
		)?.handler
		const entry = '/tmp/node_modules/pg/esm/index.mjs'
		const resolve = vi.fn(async () => ({ id: entry }))

		await expect(
			resolveId?.call({ resolve }, 'pg', '/tmp/pluxel-static-private-postgres/src/app.ts', {}),
		).resolves.toMatchObject({ id: 'pg', external: true })
		await writeBundle?.call({})

		expect(traceNodeModules).toHaveBeenCalledWith(
			[entry],
			expect.objectContaining({ rootDir: '/tmp/pluxel-static-private-postgres' }),
		)
	})

	it('rejects unknown managed database drivers', () => {
		expect(() =>
			staticApplication({
				entry: './src/pluxel.static.ts',
				managedDatabaseDrivers: ['sqlite' as never],
			}),
		).toThrow('managedDatabaseDrivers[0] must be "pglite" or "postgres"')
	})

	it('traces declared runtime packages that are absent from the module graph', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-static-residual-'))
		const packageRoot = join(root, 'workspace', 'fixture-runtime')
		try {
			await mkdir(packageRoot, { recursive: true })
			await mkdir(join(root, 'node_modules'), { recursive: true })
			await symlink(packageRoot, join(root, 'node_modules', 'fixture-runtime'), 'dir')
			await writeFile(
				join(packageRoot, 'package.json'),
				JSON.stringify({ name: 'fixture-runtime', version: '1.0.0', main: './index.cjs' }),
			)
			await writeFile(join(packageRoot, 'index.cjs'), 'module.exports = { loaded: true }\n')
			await writeFile(join(packageRoot, 'runtime.asset'), 'runtime-only asset\n')

			const config = staticApplication({
				cwd: root,
				entry: './src/pluxel.static.ts',
				outDir: './dist',
				variant: 'headless',
				target: 'node',
				lint: false,
				residualDependencies: { fullTrace: ['fixture-runtime'] },
			})
			const plugin = (
				config.plugins as Array<{
					name?: string
					buildStart?: unknown
					writeBundle?: unknown
				}>
			).find((candidate) => candidate?.name === 'pluxel:nf3-externals')
			const buildStart = plugin?.buildStart as
				| ((this: {
						resolve: ReturnType<typeof vi.fn>
						error(message: string): never
				  }) => Promise<void>)
				| undefined
			const writeBundle = (
				plugin?.writeBundle as { handler?: (this: object) => Promise<void> } | undefined
			)?.handler
			const resolve = vi.fn()
			vi.mocked(traceNodeModules).mockImplementationOnce(async (input, traceOptions) => {
				const base = traceOptions.nft?.base ?? '/'
				const fileList = new Set(
					input
						.flatMap((file) => [file, join(dirname(file), 'package.json')])
						.map((file) => relative(base, file)),
				)
				await traceOptions.hooks?.traceResult?.({ fileList } as never)
				await traceOptions.hooks?.tracedPackages?.({})
			})

			await buildStart?.call({
				resolve,
				error(message) {
					throw new Error(message)
				},
			})
			await writeBundle?.call({})

			expect(resolve).not.toHaveBeenCalled()
			expect(traceNodeModules).toHaveBeenCalledWith(
				[join(packageRoot, 'index.cjs')],
				expect.objectContaining({
					rootDir: root,
					outDir: join(root, 'dist'),
					fullTraceInclude: expect.arrayContaining(['fixture-runtime']),
				}),
			)
			await expect(
				readFile(join(root, 'dist/node_modules/fixture-runtime/runtime.asset'), 'utf8'),
			).resolves.toBe('runtime-only asset\n')
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('rejects residual dependency subpaths and invalid scoped names', () => {
		for (const packageName of ['fixture-runtime/subpath', '@scope', 'node:fs']) {
			expect(() =>
				staticApplication({
					entry: './src/pluxel.static.ts',
					residualDependencies: { packages: [packageName] },
				}),
			).toThrow('must be a package name without a subpath')
		}
	})

	it('fails the build when a declared residual package cannot be resolved', async () => {
		const config = staticApplication({
			cwd: '/tmp/pluxel-static-missing-residual',
			entry: './src/pluxel.static.ts',
			residualDependencies: { packages: ['missing-runtime-package'] },
		})
		const plugin = (
			config.plugins as Array<{
				name?: string
				buildStart?: unknown
			}>
		).find((candidate) => candidate?.name === 'pluxel:nf3-externals')
		const buildStart = plugin?.buildStart as
			| ((this: {
					resolve: ReturnType<typeof vi.fn>
					error(message: string): never
			  }) => Promise<void>)
			| undefined

		await expect(
			buildStart?.call({
				resolve: vi.fn(async () => null),
				error(message) {
					throw new Error(message)
				},
			}),
		).rejects.toThrow('residual dependency "missing-runtime-package" cannot be resolved')
	})

	it('rejects unsupported platform targets instead of emitting incomplete bundles', () => {
		expect(() =>
			staticApplication({
				entry: './src/pluxel.static.ts',
				variant: 'headless',
				target: 'fetch' as never,
			}),
		).toThrow('only the node target is currently supported')
	})

	it('keeps production bootstrap imports inside the directly installed route package', async () => {
		const source = await import('node:fs/promises').then(({ readFile: readSourceFile }) =>
			readSourceFile(new URL('../src/cli/static-application.ts', import.meta.url), 'utf8'),
		)

		expect(source).not.toContain("from '@pluxel/runtime/internal/static'")
		expect(source).not.toContain("from '@pluxel/runtime/internal'")
		expect(source).toContain("from '@pluxel/runtime/internal/static-host'")
		expect(source).toContain('@pluxel/runtime-static/internal/node-workbench-application')
		expect(source).toContain('runStaticNodeWorkbenchApplication')
		expect(source).toContain('...RuntimeFullTracePackages')
		expect(source).toContain('...residualDependencies.fullTrace')
	})
})
