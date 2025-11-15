import { describe, expect, it } from 'bun:test'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'pathe'
import { readPackageJSON } from 'pkg-types'
import { resolveBuildContext } from '../src/build/config'
import { createImportTracker } from '../src/build/plugins/import-tracker'
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
	it('adds detected pluxel imports into optionalDependencies', async () => {
		const fixtureDir = await setupFixture('basic')
		try {
			const runtime = await resolveBuildContext({ root: fixtureDir })
			expect(runtime.projectRoot).toBe(fixtureDir)
			expect(runtime.packageJsonPath).toBe(resolve(fixtureDir, 'package.json'))
			const tracker = createImportTracker(runtime.pluginPrefixes)
			const hook = createOptionalDependencyHook({
				packageJsonPath: runtime.packageJsonPath,
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
			expect(pkg.optionalDependencies?.['pluxel-plugin-alpha']).toBe('*')
		} finally {
			await teardownFixture(fixtureDir)
		}
	})
})
