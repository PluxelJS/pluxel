import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { traceNodeModules } from 'nf3'
import { describe, expect, it, vi } from 'vitest'

import { createStaticApplicationConfig as application } from '../src/cli/static-application.ts'
import { readPublicElysiaSpecifiers } from '../src/cli/elysia-singleton.ts'
import { NODE_MODULE_SOURCE_ARTIFACT_KEYS } from '../src/plugin-artifact/pluginArtifactBuildPlugin.ts'

vi.mock('nf3', () => ({ traceNodeModules: vi.fn() }))

describe('application', () => {
	it('sets Node build conditions and forwards sourcemap options', () => {
		const config = application({
			cwd: '/tmp/pluxel-static-node',
			entry: './src/pluxel.static.ts',
			variant: 'headless',
			target: 'node',
			sourcemap: true,
			sourcemapExcludeSources: true,
			lint: false,
		})

		expect(config.inputOptions?.resolve?.conditionNames).toContain('@pluxel/hmr')
		expect(config.inputOptions?.resolve?.conditionNames).toContain('production')
		expect(config.inputOptions?.resolve?.conditionNames).not.toContain('development')
		expect(config.platform).toBe('node')
		expect(config.target).toBe('node24')
		expect(config.inputOptions?.transform?.decorator).toEqual({
			legacy: true,
			emitDecoratorMetadata: false,
		})
		expect(config.entry).toEqual({ app: 'pluxel:static-application-bootstrap' })
		expect(config.sourcemap).toBe(true)
		expect(config.outputOptions).toMatchObject({ sourcemapExcludeSources: true })
	})

	it('assembles Node artifacts from every package reachable through the server bundle', async () => {
		const applicationArtifactKey = 'node-1111111111111111'
		const dependencyArtifactKey = 'node-2222222222222222'
		const root = await mkdtemp(join(tmpdir(), 'pluxel-static-node-artifacts-'))
		const outDir = join(root, 'dist')
		const dependencyRoot = join(root, 'dependency')
		const dependencyEntry = join(dependencyRoot, 'dist/index.mjs')
		const applicationEntry = join(root, 'src/pluxel.static.ts')
		try {
			await mkdir(join(outDir, 'artifacts/node'), { recursive: true })
			await mkdir(dirname(applicationEntry), { recursive: true })
			await mkdir(dirname(dependencyEntry), { recursive: true })
			await mkdir(join(dependencyRoot, 'dist/artifacts/node'), { recursive: true })
			await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture-application' }))
			await writeFile(
				join(dependencyRoot, 'package.json'),
				JSON.stringify({ name: 'fixture-dependency' }),
			)
			await writeFile(
				applicationEntry,
				[
					"import { defineHostApplication } from '@pluxel/host'",
					"export default defineHostApplication(() => ({ name: 'fixture-application', plugins: [] }))",
				].join('\n'),
			)
			await writeFile(dependencyEntry, 'export const dependency = true\n')
			await writeFile(
				join(dependencyRoot, `dist/artifacts/node/${dependencyArtifactKey}.mjs`),
				'export default function dependencyWorker() {}\n',
			)
			await writeFile(join(outDir, 'app.mjs'), 'export const start = () => undefined\n')
			await writeFile(
				join(outDir, `artifacts/node/${applicationArtifactKey}.mjs`),
				'export default function applicationWorker() {}\n',
			)

			const config = application({
				cwd: root,
				entry: './src/pluxel.static.ts',
				outDir,
				variant: 'headless',
				lint: false,
			})
			const declarationPlugin = (
				config.plugins as Array<{ name?: string; buildStart?: unknown }>
			).find((candidate) => candidate?.name === 'pluxel-static-application-declaration')
			await (
				declarationPlugin?.buildStart as
					| ((this: { error(message: string): never }) => Promise<void>)
					| undefined
			)?.call({
				error(message): never {
					throw new Error(message)
				},
			})
			const plugin = (config.plugins as Array<{ name?: string; writeBundle?: unknown }>).find(
				(candidate) => candidate?.name === 'pluxel-static-application-assembly',
			)
			const writeBundle = (
				plugin?.writeBundle as
					| {
							handler?: (options: object, bundle: object) => Promise<void>
					  }
					| undefined
			)?.handler

			await writeBundle?.call(
				{
					getModuleInfo(id: string) {
						return {
							meta: {
								[NODE_MODULE_SOURCE_ARTIFACT_KEYS]:
									id === applicationEntry ? [applicationArtifactKey] : [],
							},
						}
					},
				},
				{},
				{
					'app.mjs': {
						type: 'chunk',
						fileName: 'app.mjs',
						isEntry: true,
						facadeModuleId: '\0pluxel:static-application-bootstrap',
						imports: [],
						dynamicImports: [],
						modules: {
							[applicationEntry]: { code: JSON.stringify(applicationArtifactKey) },
							[dependencyEntry]: { code: JSON.stringify(dependencyArtifactKey) },
						},
						code: `export const artifacts = [${JSON.stringify(applicationArtifactKey)}, ${JSON.stringify(dependencyArtifactKey)}]\n`,
					},
				},
			)

			const deployment = JSON.parse(
				await readFile(join(outDir, 'pluxel-deployment.json'), 'utf8'),
			) as {
				capabilities: { nodeModules: { artifacts: Array<{ key: string }> } }
			}
			expect(deployment.capabilities.nodeModules.artifacts.map(({ key }) => key)).toEqual([
				applicationArtifactKey,
				dependencyArtifactKey,
			])
			await expect(
				readFile(join(outDir, `artifacts/node/${dependencyArtifactKey}.mjs`), 'utf8'),
			).resolves.toContain('dependencyWorker')
		} finally {
			await rm(root, { recursive: true, force: true })
		}
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

	it('keeps PostgreSQL on the Node residual boundary', async () => {
		const config = application({
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
		const config = application({
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
		const config = application({
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
			application({
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

			const config = application({
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
				return { packages: {}, files: {} }
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

	it('rejects malformed residual selections, package subpaths and invalid scoped names', () => {
		const malformed: readonly unknown[] = [null, [], 'runtime', { package: ['runtime'] }]
		for (const residualDependencies of malformed)
			expect(() =>
				application({
					entry: './src/pluxel.static.ts',
					residualDependencies: residualDependencies as never,
				}),
			).toThrow('residualDependencies')
		for (const packageName of ['fixture-runtime/subpath', '@scope', 'node:fs']) {
			expect(() =>
				application({
					entry: './src/pluxel.static.ts',
					residualDependencies: { packages: [packageName] },
				}),
			).toThrow('must be a package name without a subpath')
		}
	})

	it('fails the build when a declared residual package cannot be resolved', async () => {
		const config = application({
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

	it('rejects framework identities as explicit runtime residual packages', () => {
		for (const name of ['@pluxel/core', '@pluxel/host'])
			for (const field of ['packages', 'fullTrace'])
				expect(() =>
					application({ entry: 'app.ts', residualDependencies: { [field]: [name] } }),
				).toThrow(`${name} must be bundled`)
	})

	it('rejects a traced residual closure that carries a second framework identity', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-residual-framework-'))
		try {
			const packageRoot = join(root, 'node_modules', 'fixture-runtime')
			await mkdir(packageRoot, { recursive: true })
			await writeFile(
				join(packageRoot, 'package.json'),
				JSON.stringify({ name: 'fixture-runtime', version: '1.0.0', main: 'index.cjs' }),
			)
			await writeFile(join(packageRoot, 'index.cjs'), "module.exports = require('@pluxel/core')")
			const config = application({
				cwd: root,
				entry: 'app.ts',
				variant: 'headless',
				lint: false,
				residualDependencies: { packages: ['fixture-runtime'] },
			})
			const plugins = config.plugins as Array<{
				name?: string
				buildStart?: () => Promise<void>
				writeBundle?: { handler?: (options: object, bundle: object) => Promise<void> }
			}>
			const tracer = plugins.find((plugin) => plugin?.name === 'pluxel:nf3-externals')!
			const assembly = plugins.find(
				(plugin) => plugin?.name === 'pluxel-static-application-assembly',
			)!
			await tracer.buildStart?.call({
				resolve: vi.fn(),
				error(message: string) {
					throw new Error(message)
				},
			})
			vi.mocked(traceNodeModules).mockImplementationOnce(async (_input, options) => {
				await options.hooks?.tracedPackages?.({
					'@pluxel/core': { name: '@pluxel/core', versions: {} },
				})
				return { packages: {}, files: {} }
			})
			await tracer.writeBundle?.handler?.call({}, {}, {})
			await expect(assembly.writeBundle?.handler?.call({}, {}, {})).rejects.toThrow(
				'traced residual dependencies include @pluxel/core',
			)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('rejects unsupported platform targets instead of emitting incomplete bundles', () => {
		expect(() =>
			application({
				entry: './src/pluxel.static.ts',
				variant: 'headless',
				target: 'fetch' as never,
			}),
		).toThrow('only the node target is currently supported')
	})
})
