import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { InstallOptions, InstallResult, ParsedBareSpecifier } from '@pnpm/napi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PnpmEngine } from '../src/pnpm-engine.ts'
import { ManagedPackageStore } from '../src/store.ts'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<string> {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-package-manager-'))
	roots.push(root)
	return root
}

function createEngine() {
	const install = vi.fn(async (options: InstallOptions): Promise<InstallResult> => {
		const manifest = options.projects[0]!.manifest
		const nodeModules = resolve(options.dir, 'node_modules')
		await rm(nodeModules, { recursive: true, force: true })
		for (const [name, requested] of Object.entries(manifest.dependencies ?? {})) {
			const directory = resolve(nodeModules, ...name.split('/'))
			await mkdir(directory, { recursive: true })
			await writeFile(
				resolve(directory, 'package.json'),
				JSON.stringify({ name, version: requested.replace(/^[^0-9]*/, '') || '1.0.0' }),
			)
		}
		return { stats: { added: 1, removed: 0, linkedToRoot: 1 }, storeDir: '/store' }
	})
	const parseBareSpecifier = (spec: string): ParsedBareSpecifier | null => {
		const scoped = spec.match(/^(@[^/]+\/[^@]+)(?:@(.+))?$/)
		if (scoped) return { name: scoped[1], bareSpecifier: scoped[2] ?? 'latest' }
		const plain = spec.match(/^([^@/]+)(?:@(.+))?$/)
		if (plain) return { name: plain[1], bareSpecifier: plain[2] ?? 'latest' }
		return null
	}
	const engine: PnpmEngine = {
		engineVersion: () => 'test-engine',
		install,
		parseBareSpecifier,
		readConfig: () =>
			({
				registries: [{ name: 'default', url: 'https://registry.npmjs.org/' }],
				authHeaderByUri: {},
				storeDir: '/store',
				cacheDir: '/cache',
				networkConcurrency: 16,
				fetchRetries: 2,
				fetchRetryFactor: 10,
				fetchRetryMintimeout: 10,
				fetchRetryMaxtimeout: 100,
				fetchTimeout: 1_000,
			}) as ReturnType<PnpmEngine['readConfig']>,
	}
	return { engine, install }
}

describe('ManagedPackageStore', () => {
	it('publishes entry files only after install and removes them only after prune succeeds', async () => {
		const rootDir = await fixtureRoot()
		const { engine, install } = createEngine()
		const store = new ManagedPackageStore(engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 1_440,
		})
		await store.initialize()

		const result = await store.install(['alpha@^1.2.0', '@scope/beta@2.0.0'])

		expect(result).toMatchObject({ ok: true, succeeded: ['alpha', '@scope/beta'] })
		expect(install).toHaveBeenCalledTimes(1)
		const snapshot = await store.snapshot()
		expect(snapshot.packages.map(({ name }) => name)).toEqual(['@scope/beta', 'alpha'])
		expect(snapshot.packages.every(({ entryFile }) => entryFile?.endsWith('.mjs'))).toBe(true)
		const entryFiles = await readdir(snapshot.entriesDir)
		expect(entryFiles).toHaveLength(2)
		const wrapper = await readFile(resolve(snapshot.entriesDir, entryFiles[0]!), 'utf8')
		expect(wrapper).toContain('export * from')
		expect(wrapper).toContain('export default pluginModule.default')

		const removed = await store.remove(['alpha', '@scope/beta'])

		expect(removed).toEqual({ ok: true, succeeded: ['alpha', '@scope/beta'], failed: [] })
		expect(install).toHaveBeenCalledTimes(2)
		const removedSnapshot = await store.snapshot()
		expect(removedSnapshot.packages).toEqual([])
		expect(await readdir(resolve(rootDir, 'entries'))).toEqual([])
	})

	it('rejects non-registry, empty, and non-canonical inputs without invoking the native engine', async () => {
		const rootDir = await fixtureRoot()
		const { engine, install } = createEngine()
		const store = new ManagedPackageStore(engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
		})
		await store.initialize()

		const result = await store.install([
			'../local-directory',
			'',
			'Alpha@1.0.0',
			'alpha@file:../local',
			'alpha@https://registry.example.test/alpha.tgz',
			'alpha@github:owner/repo',
			'alias@npm:alpha@1.0.0',
		])

		expect(result.ok).toBe(false)
		expect(result.failed).toHaveLength(7)
		expect(result.failed.every(({ code }) => code === 'INVALID_SPEC')).toBe(true)
		await expect(store.install(null as never)).resolves.toMatchObject({
			ok: false,
			failed: [{ code: 'INVALID_SPEC' }],
		})
		await expect(
			store.install(Array.from({ length: 101 }, () => 'alpha@1.0.0')),
		).resolves.toMatchObject({
			ok: false,
			failed: [{ code: 'INVALID_SPEC' }],
		})
		expect(install).not.toHaveBeenCalled()
	})

	it('keeps the previous manifest and entries when the native install fails', async () => {
		const rootDir = await fixtureRoot()
		const { engine, install } = createEngine()
		const store = new ManagedPackageStore(engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
		})
		await store.initialize()
		install.mockRejectedValueOnce(
			new Error('request failed https://user:secret@registry.example.test/private?token=secret'),
		)

		const result = await store.install(['alpha@1.0.0'])

		expect(result).toMatchObject({ ok: false, succeeded: [] })
		expect(result.failed[0]?.message).toBe('pnpm could not apply the managed dependency graph')
		expect(JSON.parse(await readFile(resolve(rootDir, 'package.json'), 'utf8'))).toMatchObject({
			dependencies: {},
		})
		expect(await readdir(resolve(rootDir, 'entries'))).toEqual([])
	})

	it('does not publish persisted dependencies that are not materialized', async () => {
		const rootDir = await fixtureRoot()
		const { engine } = createEngine()
		await writeFile(
			resolve(rootDir, 'package.json'),
			JSON.stringify({
				name: '@pluxel/managed-plugins',
				private: true,
				type: 'module',
				dependencies: { alpha: '^1.0.0' },
			}),
		)
		const store = new ManagedPackageStore(engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
		})

		await store.initialize()

		const snapshot = await store.snapshot()
		expect(snapshot.packages[0]).toMatchObject({
			name: 'alpha',
			installedVersion: null,
			entryFile: null,
		})
		expect(await readdir(snapshot.entriesDir)).toEqual([])
	})

	it('rejects contradictory dependency-script policy', async () => {
		const rootDir = await fixtureRoot()
		const { engine } = createEngine()

		expect(
			() =>
				new ManagedPackageStore(engine, {
					rootDir,
					ignoreScripts: true,
					allowBuilds: ['native-addon'],
					minimumReleaseAgeMinutes: 0,
				}),
		).toThrow(/allowBuilds requires ignoreScripts=false/)
		expect(
			() =>
				new ManagedPackageStore(engine, {
					rootDir,
					ignoreScripts: false,
					allowBuilds: [],
					minimumReleaseAgeMinutes: 0,
				}),
		).toThrow(/requires at least one exact allowBuilds/)
	})
})
