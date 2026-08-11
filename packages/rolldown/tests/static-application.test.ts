import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { traceNodeModules } from 'nf3'
import { describe, expect, it, vi } from 'vitest'
import {
	WORKBENCH_SHELL_BUILD_INFO_FILE,
	WORKBENCH_SHELL_BUILD_INFO_VERSION,
} from '@pluxel/core/federation'

import { createPluginBuildPipeline, pluginPackage } from '../src/cli/plugin-build.ts'
import {
	assertWorkbenchShellContractProtocol,
	staticApplication,
} from '../src/cli/static-application.ts'

vi.mock('nf3', () => ({ traceNodeModules: vi.fn() }))

function pluginNames(config: { plugins?: unknown }): string[] {
	return (config.plugins as Array<{ name?: string } | null | undefined>)
		.filter((plugin): plugin is { name?: string } => Boolean(plugin))
		.map((plugin) => plugin.name ?? '')
}

describe('staticApplication', () => {
	it('exposes one standard plugin package preset and shared source pipeline', () => {
		const pipeline = createPluginBuildPipeline({ root: '/tmp/pluxel-plugin-package' })
		const config = pluginPackage({ root: '/tmp/pluxel-plugin-package' })

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
		expect(config.inputOptions?.transform?.decorator).toEqual({
			legacy: true,
			emitDecoratorMetadata: true,
		})
	})

	it('keeps semantic package metadata inside the plugin package preset', () => {
		const config = pluginPackage({
			root: '/tmp/pluxel-plugin-package',
			packageMetadata: {
				packageJsonPath: '/tmp/pluxel-plugin-package/package.json',
				manifestField: 'pluxel',
				prefixes: ['pluxel-plugin'],
				log: () => undefined,
			},
		})
		expect(pluginNames(config).filter((name) => name === 'pluxel:plugin-semantics')).toHaveLength(1)
		expect(config.onSuccess).toBeTypeOf('function')
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
			lint: false,
		})

		expect(config.platform).toBe('node')
		expect(config.target).toBe('node24')
		expect(pluginNames(config)).toContain('pluxel:nf3-externals')
		expect(pluginNames(config)).toContain('pluxel:decorator-output-guard')
		expect(config.inputOptions?.transform?.decorator).toEqual({
			legacy: true,
			emitDecoratorMetadata: true,
		})
		expect(config.entry).toEqual({ app: 'pluxel:static-application-bootstrap' })
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
		const source = await plugin?.load?.(String(resolved))

		expect(resolved).toBe('\0pluxel:static-application-bootstrap')
		expect(source).toContain('import * as __pluxelHostModule')
		expect(source).toContain('/tmp/pluxel-static-node/src/pluxel.static.ts')
		expect(source).toContain('readHostProduct as __readHostProduct')
		expect(source).toContain('__pluxelHostModule.default')
		expect(source).toContain('product: __pluxelProduct')
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

	it('rejects a stale Workbench shell contract protocol during static assembly', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-workbench-shell-'))
		try {
			await expect(assertWorkbenchShellContractProtocol(root, 2)).rejects.toThrow(
				'build info is missing or invalid',
			)
			await writeFile(
				join(root, WORKBENCH_SHELL_BUILD_INFO_FILE),
				JSON.stringify({
					version: WORKBENCH_SHELL_BUILD_INFO_VERSION,
					contractProtocol: 1,
				}),
			)
			await expect(assertWorkbenchShellContractProtocol(root, 2)).rejects.toThrow(
				'expected 2, built 1',
			)
			await writeFile(
				join(root, WORKBENCH_SHELL_BUILD_INFO_FILE),
				JSON.stringify({
					version: WORKBENCH_SHELL_BUILD_INFO_VERSION,
					contractProtocol: 2,
				}),
			)
			await expect(assertWorkbenchShellContractProtocol(root, 2)).resolves.toBeUndefined()
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('keeps production bootstrap imports inside the directly installed route package', async () => {
		const source = await import('node:fs/promises').then(({ readFile: readSourceFile }) =>
			readSourceFile(new URL('../src/cli/static-application.ts', import.meta.url), 'utf8'),
		)

		expect(source).not.toContain("from '@pluxel/runtime/internal/static'")
		expect(source).toContain('@pluxel/runtime-static/internal/node-workbench-application')
		expect(source).toContain('runStaticNodeWorkbenchApplication')
		expect(source).toContain('...RuntimeFullTracePackages')
		expect(source).toContain('...residualDependencies.fullTrace')
	})
})
