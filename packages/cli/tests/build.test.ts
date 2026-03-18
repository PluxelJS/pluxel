import { describe, expect, it, vi } from 'vitest'
import { createFixture } from 'fs-fixture'
import { createImportTracker } from '@pluxel/cli/rolldown'
import { resolve } from 'pathe'
import { readPackageJSON } from 'pkg-types'
import {
	BuildEnvKeys,
	createOptionalDependencyHook,
	resolveBuildContext,
	runWithTsdown,
} from '@pluxel/cli/build'

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
			"\texternal: ['pluxel-plugin-alpha', 'pluxel-plugin-beta'],",
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
			"\texternal: ['acme-plugin-alpha', 'acme-plugin-beta'],",
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
			await withBuildFixture('custom', async (fixtureDir) => {
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
})
