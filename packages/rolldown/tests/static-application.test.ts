import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { traceNodeModules } from 'nf3'
import { describe, expect, it, vi } from 'vitest'

import { createStaticApplicationConfig as application } from '../src/cli/static-application.ts'

vi.mock('nf3', () => ({ traceNodeModules: vi.fn() }))

describe('application', () => {
	it.each(['pg', '@electric-sql/pglite'])('traces the imported driver %s', async (driver) => {
		vi.mocked(traceNodeModules).mockClear()
		const config = application({
			cwd: '/tmp/pluxel-static-private-postgres',
			entry: './src/pluxel.static.ts',
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
		const entry = `/tmp/node_modules/${driver}/index.mjs`
		const resolve = vi.fn(async () => ({ id: entry }))

		await expect(
			resolveId?.call({ resolve }, driver, '/tmp/pluxel-static-private-postgres/src/app.ts', {}),
		).resolves.toMatchObject({ id: driver, external: true })
		await writeBundle?.call({})

		expect(traceNodeModules).toHaveBeenCalledWith(
			[entry],
			expect.objectContaining({ rootDir: '/tmp/pluxel-static-private-postgres' }),
		)
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
