import { describe, expect, it, vi } from 'vitest'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { createImportTracker } from '@pluxel/rolldown/plugins'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'pathe'
import { readPackageJSON } from 'pkg-types'
import {
	BuildEnvKeys,
	cliTsdownOverlay,
	createOptionalDependencyHook,
	resolveBuildContext,
	runWithTsdown,
} from '@pluxel/rolldown/build'

const buildFixtures = {
	basic: {
		'package.json': JSON.stringify(
			{
				name: 'pluxel-cli-build-fixture',
				version: '1.0.0',
				type: 'module',
				dependencies: {
					'pluxel-plugin-alpha': '^1.0.0',
				},
				devDependencies: {
					'pluxel-plugin-beta': '^0.5.0',
				},
				peerDependencies: {},
				optionalDependencies: {},
			},
			null,
			2,
		),
		'tsconfig.json': JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2020',
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: false,
					declaration: false,
					allowSyntheticDefaultImports: true,
					esModuleInterop: true,
				},
				include: ['src'],
			},
			null,
			2,
		),
		'tsdown.config.ts': [
			'export default {',
			"\tentry: 'src/index.ts',",
			"\tformat: ['esm'],",
			'\tdts: false,',
			"\tdeps: { neverBundle: ['pluxel-plugin-alpha', 'pluxel-plugin-beta'] },",
			'\tsourcemap: false,',
			'\tclean: true,',
			'}',
			'',
		].join('\n'),
		'src/index.ts': [
			"import 'pluxel-plugin-alpha'",
			"import 'pluxel-plugin-beta'",
			'',
			'// @Plugin marker for import tracking',
			'export const answer = 42',
			'',
		].join('\n'),
	},
	custom: {
		'package.json': JSON.stringify(
			{
				name: 'pluxel-cli-build-fixture-custom',
				version: '1.0.0',
				type: 'module',
				dependencies: {
					'acme-plugin-alpha': '1.2.3',
				},
				devDependencies: {
					'acme-plugin-beta': '~1.0.0',
				},
				peerDependencies: {
					'acme-plugin-beta': '~1.0.0',
				},
				optionalDependencies: {},
			},
			null,
			2,
		),
		'tsconfig.json': JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2020',
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: false,
					declaration: false,
					allowSyntheticDefaultImports: true,
					esModuleInterop: true,
				},
				include: ['src'],
			},
			null,
			2,
		),
		'tsdown.config.ts': [
			'export default {',
			"\tentry: 'src/index.ts',",
			"\tformat: ['esm'],",
			'\tdts: false,',
			"\tdeps: { neverBundle: ['acme-plugin-alpha', 'acme-plugin-beta'] },",
			'\tsourcemap: false,',
			'\tclean: true,',
			'}',
			'',
		].join('\n'),
		'src/index.ts': [
			"import 'acme-plugin-alpha'",
			"import 'acme-plugin-beta'",
			'',
			'// @Plugin marker for import tracking',
			'export const answer = 24',
			'',
		].join('\n'),
	},
	runtimeUi: {
		'package.json': JSON.stringify(
			{
				name: 'pluxel-cli-build-fixture-runtime-ui',
				version: '1.0.0',
				type: 'module',
			},
			null,
			2,
		),
		'package-lock.json': JSON.stringify({ lockfileVersion: 3 }),
		'tsconfig.json': JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2020',
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: false,
					declaration: false,
					allowSyntheticDefaultImports: true,
					esModuleInterop: true,
				},
				include: ['src'],
			},
			null,
			2,
		),
		'tsdown.config.ts': [
			'export default {',
			"\tentry: 'src/index.ts',",
			"\tformat: ['esm'],",
			'\tdts: false,',
			'\tsourcemap: false,',
			'\tclean: true,',
			'}',
			'',
		].join('\n'),
		'src/index.ts': [
			"import { workbench } from '@pluxel/runtime/workbench'",
			"import { workbenchContract } from '@pluxel/runtime/workbench/contract'",
			'',
			"const extension = workbench.extension({ contract: workbenchContract.define({}), entry: workbench.entry(import.meta.url, './ui/index.ts') })",
			"const secondExtension = workbench.extension({ contract: workbenchContract.define({}), entry: workbench.entry(import.meta.url, './ui/second.ts') })",
			'',
			'export function registerWorkbench(gate: any) {',
			'\treturn gate.mount(extension, {})',
			'}',
			'export { secondExtension }',
			'',
		].join('\n'),
		'src/ui/index.ts': [
			"export const UI_ONLY_MARKER = '__PLUXEL_UI_ONLY_MARKER__'",
			'export default { views: {} }',
			'',
		].join('\n'),
		'src/ui/second.ts': [
			"export const SECOND_UI_ONLY_MARKER = '__PLUXEL_SECOND_UI_ONLY_MARKER__'",
			'export default { views: {} }',
			'',
		].join('\n'),
	},
	decoratedPlugin: {
		'package.json': JSON.stringify(
			{
				name: 'pluxel-cli-build-fixture-decorated-plugin',
				version: '1.0.0',
				type: 'module',
			},
			null,
			2,
		),
		'tsconfig.json': JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2020',
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: false,
					declaration: false,
				},
				include: ['src'],
			},
			null,
			2,
		),
		'tsdown.config.ts': [
			'export default {',
			"\tentry: 'src/index.ts',",
			"\tformat: ['esm'],",
			'\tdts: false,',
			'\tminify: false,',
			'\tsourcemap: false,',
			'\tclean: true,',
			'\tinputOptions(options) {',
			'\t\treturn {',
			'\t\t\t...options,',
			'\t\t\ttransform: {',
			'\t\t\t\t...options.transform,',
			'\t\t\t\tdefine: { ...options.transform?.define, __FIXTURE_INPUT__: JSON.stringify("preserved") },',
			'\t\t\t},',
			'\t\t}',
			'\t},',
			'}',
			'',
		].join('\n'),
		'src/index.ts': [
			"import { BasePlugin, Plugin } from '@pluxel/runtime/authoring'",
			'declare const __FIXTURE_INPUT__: string',
			'export const inputOverride = __FIXTURE_INPUT__',
			'',
			"@Plugin({ name: 'FixtureProvider' })",
			'export class FixtureProvider extends BasePlugin {}',
			'',
			"@Plugin({ name: 'FixtureConsumer' })",
			'export class FixtureConsumer extends BasePlugin {',
			'\tconstructor(readonly provider: FixtureProvider) {',
			'\t\tsuper()',
			'\t}',
			'}',
			'',
		].join('\n'),
	},
	deprecatedTsdownKeys: {
		'package.json': JSON.stringify(
			{
				name: 'pluxel-cli-build-fixture-deprecated-keys',
				version: '1.0.0',
				type: 'module',
			},
			null,
			2,
		),
		'tsconfig.json': JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2020',
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: false,
					declaration: false,
					allowSyntheticDefaultImports: true,
					esModuleInterop: true,
				},
				include: ['src'],
			},
			null,
			2,
		),
		'tsdown.config.ts': [
			'export default {',
			"\tentry: 'src/index.ts',",
			"\tformat: ['esm'],",
			'\tdts: false,',
			"\texternal: ['pluxel-plugin-alpha'],",
			'\tsourcemap: false,',
			'\tclean: true,',
			'}',
			'',
		].join('\n'),
		'src/index.ts': ['export const answer = 1', ''].join('\n'),
	},
	arrayTsdownConfig: {
		'package.json': JSON.stringify(
			{
				name: 'pluxel-cli-build-fixture-array-config',
				version: '1.0.0',
				type: 'module',
			},
			null,
			2,
		),
		'tsconfig.json': JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2020',
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: false,
					declaration: false,
					allowSyntheticDefaultImports: true,
					esModuleInterop: true,
				},
				include: ['src'],
			},
			null,
			2,
		),
		'tsdown.config.ts': [
			'export default [',
			'\t{',
			"\t\tentry: 'src/index.ts',",
			"\t\tformat: ['esm'],",
			'\t\tdts: false,',
			'\t\tsourcemap: false,',
			'\t\tclean: true,',
			'\t},',
			']',
			'',
		].join('\n'),
		'src/index.ts': ['export const answer = 2', ''].join('\n'),
	},
} satisfies Record<string, Record<string, string>>

async function withBuildFixture<T>(
	name: keyof typeof buildFixtures,
	run: (dir: string) => Promise<T>,
) {
	await using fixture = await createFixture(buildFixtures[name])
	const originalCwd = process.cwd()
	try {
		process.chdir(fixture.path)
		return await run(fixture.path)
	} finally {
		process.chdir(originalCwd)
	}
}

describe('build command', () => {
	it('synchronizes detected pluxel imports into package.json metadata', async () => {
		await withBuildFixture('basic', async (fixtureDir) => {
			const runtime = await resolveBuildContext({})
			expect(runtime.projectRoot).toBe(fixtureDir)
			expect(runtime.packageJsonPath).toBe(resolve(fixtureDir, 'package.json'))
			const tracker = createImportTracker({ prefixes: runtime.pluginPrefixes })
			const hook = createOptionalDependencyHook({
				packageJsonPath: runtime.packageJsonPath,
				manifestField: runtime.manifestField,
				log: () => {},
				collectPlugins: () => tracker.flush(),
			})

			await runWithTsdown({
				context: runtime,
				onSuccess: hook,
				log: () => {},
				extraConfig: {
					plugins: [tracker.plugin],
				},
			})

			const pkg = await readPackageJSON(runtime.packageJsonPath)
			expect(pkg.optionalDependencies?.['pluxel-plugin-alpha']).toBeUndefined()
			expect(pkg.optionalDependencies?.['pluxel-plugin-beta']).toBeUndefined()
			expect(pkg.peerDependencies?.['pluxel-plugin-alpha']).toBe('^1.0.0')
			expect(pkg.peerDependencies?.['pluxel-plugin-beta']).toBe('^0.5.0')
			expect(pkg.dependencies?.['pluxel-plugin-alpha']).toBeUndefined()
			expect(pkg.devDependencies?.['pluxel-plugin-beta']).toBeUndefined()
			expect(pkg.pluxel?.dependOn?.required).toEqual(['pluxel-plugin-alpha'])
			expect(pkg.pluxel?.dependOn?.optional).toEqual(['pluxel-plugin-beta'])
		})
	})

	it('respects custom env config for prefixes and manifest fields', async () => {
		try {
			await withBuildFixture('custom', async (_fixtureDir) => {
				vi.stubEnv(BuildEnvKeys.pluginPrefix, 'acme-plugin')
				vi.stubEnv(BuildEnvKeys.manifestField, 'customField')

				const runtime = await resolveBuildContext({})
				const tracker = createImportTracker({ prefixes: runtime.pluginPrefixes })
				const hook = createOptionalDependencyHook({
					packageJsonPath: runtime.packageJsonPath,
					manifestField: runtime.manifestField,
					log: () => {},
					collectPlugins: () => tracker.flush(),
				})

				await runWithTsdown({
					context: runtime,
					onSuccess: hook,
					log: () => {},
					extraConfig: {
						plugins: [tracker.plugin],
					},
				})

				const pkg = await readPackageJSON(runtime.packageJsonPath)
				expect(pkg.optionalDependencies?.['acme-plugin-alpha']).toBeUndefined()
				expect(pkg.optionalDependencies?.['acme-plugin-beta']).toBeUndefined()
				expect(pkg.peerDependencies?.['acme-plugin-alpha']).toBe('1.2.3')
				expect(pkg.peerDependencies?.['acme-plugin-beta']).toBe('~1.0.0')
				expect(pkg.dependencies?.['acme-plugin-alpha']).toBeUndefined()
				expect(pkg.devDependencies?.['acme-plugin-beta']).toBeUndefined()
				expect(pkg.customField?.dependOn?.required).toEqual(['acme-plugin-alpha'])
				expect(pkg.customField?.dependOn?.optional).toEqual(['acme-plugin-beta'])
			})
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it('fills repository metadata from GitHub env', async () => {
		try {
			await withBuildFixture('basic', async () => {
				vi.stubEnv('GITHUB_ACTIONS', 'true')
				vi.stubEnv('GITHUB_REPOSITORY', 'pluxel/example')

				const runtime = await resolveBuildContext({})
				const tracker = createImportTracker({ prefixes: runtime.pluginPrefixes })
				const hook = createOptionalDependencyHook({
					packageJsonPath: runtime.packageJsonPath,
					manifestField: runtime.manifestField,
					log: () => {},
					collectPlugins: () => tracker.flush(),
				})

				await runWithTsdown({
					context: runtime,
					onSuccess: hook,
					log: () => {},
					extraConfig: {
						plugins: [tracker.plugin],
					},
				})

				const pkg = await readPackageJSON(runtime.packageJsonPath)
				expect(pkg.repository).toEqual({
					type: 'git',
					url: 'https://github.com/pluxel/example.git',
				})
				expect(pkg.homepage).toBe('https://github.com/pluxel/example')
				expect(pkg.bugs).toEqual({ url: 'https://github.com/pluxel/example/issues' })
			})
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it('fills repository metadata from GitLab env', async () => {
		try {
			await withBuildFixture('basic', async () => {
				vi.stubEnv('GITLAB_CI', 'true')
				vi.stubEnv('CI_PROJECT_PATH', 'pluxel/example')
				vi.stubEnv('CI_SERVER_HOST', 'gitlab.com')

				const runtime = await resolveBuildContext({})
				const tracker = createImportTracker({ prefixes: runtime.pluginPrefixes })
				const hook = createOptionalDependencyHook({
					packageJsonPath: runtime.packageJsonPath,
					manifestField: runtime.manifestField,
					log: () => {},
					collectPlugins: () => tracker.flush(),
				})

				await runWithTsdown({
					context: runtime,
					onSuccess: hook,
					log: () => {},
					extraConfig: {
						plugins: [tracker.plugin],
					},
				})

				const pkg = await readPackageJSON(runtime.packageJsonPath)
				expect(pkg.repository).toEqual({
					type: 'git',
					url: 'https://gitlab.com/pluxel/example.git',
				})
				expect(pkg.homepage).toBe('https://gitlab.com/pluxel/example')
				expect(pkg.bugs).toEqual({ url: 'https://gitlab.com/pluxel/example/-/issues' })
			})
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it('preserves pure Workbench declarations and explicit mounting', async () => {
		await withBuildFixture('runtimeUi', async (fixtureDir) => {
			const runtime = await resolveBuildContext({})

			await runWithTsdown({
				context: runtime,
				onSuccess: async () => {},
				log: () => {},
				extraConfig: cliTsdownOverlay,
			})

			const output = await readFile(resolve(fixtureDir, 'dist/index.mjs'), 'utf-8')
			expect(output).toContain('gate.mount')
			expect(output).toContain('@pluxel/runtime/workbench')
			expect(output).not.toContain('.bind(')
			expect(output).not.toContain('__PLUXEL_UI_ONLY_MARKER__')
			expect(output).not.toContain('__PLUXEL_SECOND_UI_ONLY_MARKER__')
			const artifactNames = [...output.matchAll(/artifact-[a-f0-9]{12}/g)].map((match) => match[0])
			expect(new Set(artifactNames).size).toBe(2)

			const workbenchRoot = resolve(fixtureDir, 'dist/workbench')
			const files = await readdir(workbenchRoot, { recursive: true })
			expect(files.filter((file) => String(file).endsWith('mf-manifest.json'))).toHaveLength(2)
			expect(files.filter((file) => String(file).endsWith('remoteEntry.js'))).toHaveLength(2)
			const jsFiles = files.filter((file) => String(file).endsWith('.js')).map(String)
			const uiOutput = await Promise.all(
				jsFiles.map((file) => readFile(resolve(workbenchRoot, file), 'utf-8')),
			)
			expect(uiOutput.join('\n')).toContain('__PLUXEL_UI_ONLY_MARKER__')
			expect(uiOutput.join('\n')).toContain('__PLUXEL_SECOND_UI_ONLY_MARKER__')

			const cacheRoot = resolve(fixtureDir, '.pluxel/workbench-build')
			const cacheFiles = await readdir(cacheRoot, { recursive: true })
			const stamp = cacheFiles.find((file) => String(file).endsWith('pluxel-workbench.json'))
			expect(stamp).toBeDefined()
			const firstStamp = await stat(resolve(cacheRoot, String(stamp)))

			await runWithTsdown({
				context: runtime,
				onSuccess: async () => {},
				log: () => {},
				extraConfig: cliTsdownOverlay,
			})

			const secondStamp = await stat(resolve(cacheRoot, String(stamp)))
			expect(secondStamp.mtimeMs).toBe(firstStamp.mtimeMs)
			expect(await readFile(resolve(fixtureDir, 'dist/index.mjs'), 'utf-8')).not.toContain(
				'__PLUXEL_UI_ONLY_MARKER__',
			)
			const republishedFiles = await readdir(workbenchRoot, { recursive: true })
			expect(republishedFiles.some((file) => String(file).endsWith('mf-manifest.json'))).toBe(true)

			await writeFile(
				resolve(fixtureDir, 'package-lock.json'),
				JSON.stringify({ lockfileVersion: 3, packages: { '': { version: '1.0.1' } } }),
			)
			await runWithTsdown({
				context: runtime,
				onSuccess: async () => {},
				log: () => {},
				extraConfig: cliTsdownOverlay,
			})
			const invalidatedCacheFiles = await readdir(cacheRoot, { recursive: true })
			expect(
				invalidatedCacheFiles.filter((file) => String(file).endsWith('pluxel-workbench.json')),
			).toHaveLength(4)
		})
	}, 45_000)

	it('always lowers legacy plugin decorators and emits constructor metadata', async () => {
		await withBuildFixture('decoratedPlugin', async (fixtureDir) => {
			const runtime = await resolveBuildContext({})
			await runWithTsdown({
				context: runtime,
				onSuccess: async () => {},
				log: () => {},
				extraConfig: cliTsdownOverlay,
			})

			const output = await readFile(resolve(fixtureDir, 'dist/index.mjs'), 'utf-8')
			expect(output).not.toMatch(/@Plugin\b/)
			expect(output).toContain('design:paramtypes')
			expect(output).toContain('FixtureProvider')
			expect(output).toContain('FixtureConsumer')
			expect(output).toContain('preserved')
		})
	})

	it('does not initialize the Workbench UI builder for plugins without a UI declaration', async () => {
		await withBuildFixture('basic', async (fixtureDir) => {
			const runtime = await resolveBuildContext({})
			await runWithTsdown({
				context: runtime,
				onSuccess: async () => {},
				log: () => {},
				extraConfig: cliTsdownOverlay,
			})
			expect(
				await stat(resolve(fixtureDir, '.pluxel/workbench-build')).catch((): null => null),
			).toBeNull()
		})
	})

	it('rejects deprecated tsdown dependency keys in plugin overrides', async () => {
		await withBuildFixture('deprecatedTsdownKeys', async () => {
			const runtime = await resolveBuildContext({})

			await expect(
				runWithTsdown({
					context: runtime,
					onSuccess: async () => {},
					log: () => {},
				}),
			).rejects.toThrow(
				'tsdown user override must use deps.* keys only; found deprecated keys: external',
			)
		})
	})

	it('rejects tsdown override arrays to keep plugin build semantics singular', async () => {
		await withBuildFixture('arrayTsdownConfig', async () => {
			const runtime = await resolveBuildContext({})

			await expect(
				runWithTsdown({
					context: runtime,
					onSuccess: async () => {},
					log: () => {},
				}),
			).rejects.toThrow('tsdown override must export a single config object or async function')
		})
	})
})
