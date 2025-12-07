import { describe, expect, it } from 'bun:test'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'pathe'
import { readPackageJSON } from 'pkg-types'
import { createImportTracker } from '@pluxel/rolldown'
import { resolveBuildContext } from '../src/build/config'
import { BuildEnvKeys } from '../src/build/env'
import { createOptionalDependencyHook } from '../src/build/plugin-tracker'
import { runWithTsdown } from '../src/build/tsdown-runner'

const TEST_ROOT = new URL('.', import.meta.url)

async function setupFixture(name: string) {
	const base = resolve(TEST_ROOT.pathname, 'fixtures', name)
	const target = await mkdtemp(join(tmpdir(), `pluxel-cli-${name}-`))
	await cp(base, target, { recursive: true })
	return target
}

async function teardownFixture(dir: string) {
	await rm(dir, { recursive: true, force: true })
}

describe('build command', () => {
	it('synchronizes detected pluxel imports into package.json metadata', async () => {
		const fixtureDir = await setupFixture('basic')
		const originalCwd = process.cwd()
		try {
			process.chdir(fixtureDir)
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
		} finally {
			process.chdir(originalCwd)
			await teardownFixture(fixtureDir)
		}
	})

	it('respects custom env config for prefixes and manifest fields', async () => {
		const fixtureDir = await setupFixture('custom')
		const originalCwd = process.cwd()
		const previousEnv: Record<string, string | undefined> = {
			[BuildEnvKeys.pluginPrefix]: process.env[BuildEnvKeys.pluginPrefix],
			[BuildEnvKeys.manifestField]: process.env[BuildEnvKeys.manifestField],
		}
		try {
			process.chdir(fixtureDir)
			process.env[BuildEnvKeys.pluginPrefix] = 'acme-plugin'
			process.env[BuildEnvKeys.manifestField] = 'customField'

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
		} finally {
			process.chdir(originalCwd)
			restoreEnv(previousEnv)
			await teardownFixture(fixtureDir)
		}
	})

	it('fills repository metadata from GitHub env', async () => {
		const fixtureDir = await setupFixture('basic')
		const originalCwd = process.cwd()
		const savedEnv = snapshotEnv(['GITHUB_ACTIONS', 'GITHUB_REPOSITORY'])
		try {
			process.chdir(fixtureDir)
			process.env.GITHUB_ACTIONS = 'true'
			process.env.GITHUB_REPOSITORY = 'pluxel/example'

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
			expect(pkg.repository).toEqual({ type: 'git', url: 'https://github.com/pluxel/example.git' })
			expect(pkg.homepage).toBe('https://github.com/pluxel/example')
			expect(pkg.bugs).toEqual({ url: 'https://github.com/pluxel/example/issues' })
		} finally {
			process.chdir(originalCwd)
			restoreEnv(savedEnv)
			await teardownFixture(fixtureDir)
		}
	})

	it('fills repository metadata from GitLab env', async () => {
		const fixtureDir = await setupFixture('basic')
		const originalCwd = process.cwd()
		const savedEnv = snapshotEnv(['GITLAB_CI', 'CI_PROJECT_PATH', 'CI_SERVER_HOST'])
		try {
			process.chdir(fixtureDir)
			process.env.GITLAB_CI = 'true'
			process.env.CI_PROJECT_PATH = 'pluxel/example'
			process.env.CI_SERVER_HOST = 'gitlab.com'

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
			expect(pkg.repository).toEqual({ type: 'git', url: 'https://gitlab.com/pluxel/example.git' })
			expect(pkg.homepage).toBe('https://gitlab.com/pluxel/example')
			expect(pkg.bugs).toEqual({ url: 'https://gitlab.com/pluxel/example/-/issues' })
		} finally {
			process.chdir(originalCwd)
			restoreEnv(savedEnv)
			await teardownFixture(fixtureDir)
		}
	})
})

function restoreEnv(state: Record<string, string | undefined>) {
	for (const [key, value] of Object.entries(state)) {
		if (typeof value === 'undefined') delete process.env[key]
		else process.env[key] = value
	}
}

function snapshotEnv(keys: string[]) {
	const state: Record<string, string | undefined> = {}
	for (const key of keys) {
		state[key] = process.env[key]
	}
	return state
}
