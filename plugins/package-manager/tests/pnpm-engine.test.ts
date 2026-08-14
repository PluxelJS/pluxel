import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadPnpmEngine } from '../src/pnpm-engine.ts'
import { ManagedPackageStore } from '../src/store.ts'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('@pnpm/napi adapter', () => {
	it('loads the native engine behind the narrow store adapter', () => {
		const engine = loadPnpmEngine()
		expect(engine.engineVersion()).toMatch(/^12\./)
		expect(engine.parseBareSpecifier('@scope/plugin@^1.0.0')).toMatchObject({
			name: '@scope/plugin',
			bareSpecifier: '^1.0.0',
		})
	})
})

describe.runIf(process.env.PLUXEL_PNPM_NATIVE_INTEGRATION === '1')(
	'native registry integration',
	() => {
		it('installs, publishes, and removes a real registry package', async () => {
			const rootDir = await mkdtemp(resolve(tmpdir(), 'pluxel-pnpm-native-'))
			roots.push(rootDir)
			const store = new ManagedPackageStore(loadPnpmEngine(), {
				rootDir,
				ignoreScripts: true,
				allowBuilds: [],
				minimumReleaseAgeMinutes: 0,
			})
			await store.initialize()

			const installed = await store.install(['is-number@7.0.0'])
			expect(installed).toEqual({ ok: true, succeeded: ['is-number'], failed: [] })
			const snapshot = await store.snapshot()
			expect(snapshot.packages).toEqual([
				expect.objectContaining({
					name: 'is-number',
					installedVersion: '7.0.0',
					entryFile: expect.stringMatching(/\.mjs$/),
				}),
			])
			expect(await readdir(snapshot.entriesDir)).toHaveLength(1)

			const removed = await store.remove(['is-number'])
			expect(removed).toEqual({ ok: true, succeeded: ['is-number'], failed: [] })
			expect(await readdir(snapshot.entriesDir)).toEqual([])
		}, 60_000)
	},
)
