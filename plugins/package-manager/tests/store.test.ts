import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, symlink } from 'node:fs/promises'
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
			const directory = resolve(
				options.globalVirtualStoreDir!,
				name.replace('/', '+') + '-' + requested,
				'node_modules',
				...name.split('/'),
			)
			const link = resolve(nodeModules, ...name.split('/'))
			await mkdir(resolve(link, '..'), { recursive: true })
			await symlink(directory, link)
			await mkdir(directory, { recursive: true })
			await writeFile(
				resolve(directory, 'package.json'),
				JSON.stringify({ name, version: requested.replace(/^[^0-9]*/, '') || '1.0.0' }),
			)
		}
		const dependencies = Object.fromEntries(
			Object.entries(manifest.dependencies ?? {}).map(([name, specifier]) => [
				name,
				{ specifier, version: specifier.replace(/^[^0-9]*/, '') || '1.0.0' },
			]),
		)
		const keys = Object.entries(dependencies).map(([name, { version }]) => `${name}@${version}`)
		await writeFile(
			resolve(options.dir, 'pnpm-lock.yaml'),
			JSON.stringify({
				lockfileVersion: '9.0',
				importers: { '.': { dependencies } },
				packages: Object.fromEntries(keys.map((key) => [key, { resolution: { integrity: key } }])),
				snapshots: Object.fromEntries(keys.map((key) => [key, {}])),
			}),
		)
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
				virtualStoreDirMaxLength: 120,
				enableGlobalVirtualStore: false,
				globalVirtualStoreDir: '/store/links',
				virtualStoreDir: '/managed/node_modules/.pnpm',
				effectiveVirtualStoreDir: '/managed/node_modules/.pnpm',
				engineStrict: false,
				packageImportMethod: 'auto',
				shamefullyHoist: false,
				explicitSettings: [],
				networkConcurrency: 16,
				fetchRetries: 2,
				fetchRetryFactor: 10,
				fetchRetryMintimeout: 10,
				fetchRetryMaxtimeout: 100,
				fetchTimeout: 1_000,
				fetchWarnTimeoutMs: 10_000,
				fetchMinSpeedKiBps: 50,
			}) satisfies ReturnType<PnpmEngine['readConfig']>,
	}
	return { engine, install }
}

describe('ManagedPackageStore', () => {
	it('reports individually published entries when a later wrapper fails', async () => {
		const rootDir = await fixtureRoot()
		const { engine } = createEngine()
		const store = new ManagedPackageStore(engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
		})
		await store.initialize()
		const blocked = resolve(store.entriesDir, Buffer.from('beta').toString('base64url') + '.mjs')
		await mkdir(blocked)
		try {
			const result = await store.install(['alpha@1.0.0', 'beta@1.0.0'])
			expect(result).toMatchObject({
				ok: false,
				succeeded: ['alpha'],
				failed: [{ input: 'beta@1.0.0', code: 'INSTALL_FAILED' }],
			})
			const published = await store.snapshot()
			expect(published.packages).toMatchObject([
				{ name: 'alpha', entryFile: expect.any(String) },
				{ name: 'beta', entryFile: null },
			])
			await rm(blocked, { recursive: true })
			expect(await store.install(['beta@1.0.0'])).toMatchObject({ ok: true })
		} finally {
			await store.close()
		}
	})

	it('retries failed withdrawal without reinstalling or losing the remaining published entries', async () => {
		const rootDir = await fixtureRoot()
		const { engine, install } = createEngine()
		const store = new ManagedPackageStore(engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
		})
		await store.initialize()
		try {
			expect(await store.install(['alpha@1.0.0', 'beta@1.0.0'])).toMatchObject({ ok: true })
			const entry = resolve(store.entriesDir, Buffer.from('alpha').toString('base64url') + '.mjs')
			const original = await readFile(entry, 'utf8')
			// Inject only the filesystem publication failure; selection and receipts remain real.
			const publication = vi.spyOn(
				store as unknown as { publishEntries(entries: ReadonlyMap<string, string>): Promise<void> },
				'publishEntries',
			)
			publication.mockRejectedValueOnce(
				Object.assign(new Error('unlink denied'), { code: 'EACCES' }),
			)
			expect(await store.remove(['alpha'])).toMatchObject({
				ok: false,
				succeeded: [],
				failed: [{ input: 'alpha', code: 'REMOVE_FAILED' }],
			})
			expect(await readFile(entry, 'utf8')).toBe(original)
			const afterFailure = await store.snapshot()
			expect(afterFailure.packages.map((pkg) => pkg.name)).toEqual(['beta'])
			const attempts = install.mock.calls.length
			publication.mockRejectedValueOnce(new Error('unlink still denied'))
			expect(await store.remove(['alpha'])).toMatchObject({
				ok: false,
				failed: [{ input: 'alpha' }],
			})
			expect(await store.remove(['alpha'])).toEqual({ ok: true, succeeded: ['alpha'], failed: [] })
			expect(install).toHaveBeenCalledTimes(attempts)
			await expect(readFile(entry)).rejects.toMatchObject({ code: 'ENOENT' })
			const afterRetry = await store.snapshot()
			expect(afterRetry.packages).toMatchObject([{ name: 'beta', entryFile: expect.any(String) }])
			expect(await store.remove(['alpha'])).toMatchObject({
				ok: false,
				failed: [{ message: 'Package is not managed' }],
			})
			await store.install(['alpha@1.0.0'])
			publication.mockRejectedValueOnce(new Error('withdrawal failed'))
			await store.remove(['alpha'])
			publication.mockRejectedValueOnce(new Error('mixed withdrawal failed'))
			expect(await store.remove(['alpha', 'beta'])).toMatchObject({
				ok: false,
				succeeded: [],
				failed: [{ input: 'alpha' }, { input: 'beta' }],
			})
			expect(await store.remove(['alpha', 'beta'])).toEqual({
				ok: true,
				succeeded: ['alpha', 'beta'],
				failed: [],
			})
			expect(await readdir(store.entriesDir)).toEqual([])
		} finally {
			await store.close()
		}
	})

	it('captures install and remove inputs before queued work starts', async () => {
		const rootDir = await fixtureRoot()
		const { engine } = createEngine()
		const store = new ManagedPackageStore(engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
		})
		await store.initialize()
		try {
			const specs = ['alpha@1.0.0']
			const installing = store.install(specs)
			specs[0] = 'beta@1.0.0'
			expect(await installing).toMatchObject({ ok: true, succeeded: ['alpha'] })
			const names = ['alpha']
			const removing = store.remove(names)
			names[0] = 'beta'
			expect(await removing).toMatchObject({ ok: true, succeeded: ['alpha'] })
		} finally {
			await store.close()
		}
	})

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
		await store.install(['alpha@^1.2.0', '@scope/beta@2.0.0'])
		expect(await readFile(resolve(snapshot.entriesDir, entryFiles[0]!), 'utf8')).toBe(wrapper)
		const retainedPath = resolve(snapshot.entriesDir, snapshot.packages[0]!.entryFile!)
		const beforeRestart = await stat(retainedPath)
		await expect(store.initialize()).rejects.toThrow('already initialized')
		expect(await store.remove(['alpha'])).toEqual({ ok: true, succeeded: ['alpha'], failed: [] })
		expect(await stat(retainedPath)).toMatchObject({ ino: beforeRestart.ino })
		const removed = await store.remove(['@scope/beta'])

		expect(removed).toEqual({ ok: true, succeeded: ['@scope/beta'], failed: [] })
		expect(install).toHaveBeenCalledTimes(4)
		const removedSnapshot = await store.snapshot()
		expect(removedSnapshot.packages).toEqual([])
		expect(await readdir(resolve(rootDir, 'entries'))).toEqual([])
	})

	it('invalidates changed transitive, peer and optional snapshots while preserving unrelated entries', async () => {
		const rootDir = await fixtureRoot()
		const { engine, install } = createEngine()
		const original = install.getMockImplementation()!
		let version = '1.0.0'
		install.mockImplementation(async (options) => {
			const result = await original(options)
			const path = resolve(options.dir, 'pnpm-lock.yaml')
			const lock = JSON.parse(await readFile(path, 'utf8'))
			const peerKey = `shared@1.0.0(peer@${version})`
			lock.snapshots['alpha@1.0.0'] = { dependencies: { shared: `1.0.0(peer@${version})` } }
			lock.snapshots[peerKey] = {
				dependencies: { peer: version },
				optionalDependencies: { optional: version },
			}
			for (const [name, current] of [
				['shared', '1.0.0'],
				['peer', version],
				['optional', version],
			]) {
				lock.packages[`${name}@${current}`] = { resolution: { integrity: `${name}-${current}` } }
				if (name !== 'shared') lock.snapshots[`${name}@${current}`] = {}
			}
			await writeFile(path, JSON.stringify(lock))
			return result
		})
		const store = new ManagedPackageStore(engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
		})
		await store.initialize()
		await store.install(['alpha@1.0.0', 'beta@1.0.0'])
		const { packages } = await store.snapshot()
		const entry = (name: string) =>
			resolve(store.entriesDir, packages.find((pkg) => pkg.name === name)!.entryFile!)
		const alpha = await readFile(entry('alpha'), 'utf8')
		const beta = await stat(entry('beta'))
		version = '2.0.0'
		await store.install(['alpha@1.0.0'])
		expect(await readFile(entry('alpha'), 'utf8')).not.toBe(alpha)
		expect(await stat(entry('beta'))).toMatchObject({ ino: beta.ino })
	})

	it('revokes publication during native work and waits for actual settlement on close', async () => {
		const rootDir = await fixtureRoot()
		const { engine, install } = createEngine()
		const controller = new AbortController()
		const store = new ManagedPackageStore(engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
			signal: controller.signal,
		})
		await store.initialize()
		const started = Promise.withResolvers<void>()
		const finish = Promise.withResolvers<InstallResult>()
		install.mockImplementationOnce(async () => {
			started.resolve()
			return finish.promise
		})
		const operation = store.install(['alpha@1.0.0'])
		await started.promise
		controller.abort(new Error('owner stopped'))
		let closed = false
		const closing = store.close().then((): void => {
			closed = true
			return undefined
		})
		await Promise.resolve()
		expect(closed).toBe(false)
		finish.resolve({ stats: { added: 1, removed: 0, linkedToRoot: 1 }, storeDir: '/store' })
		await expect(operation).resolves.toMatchObject({ ok: false, succeeded: [] })
		await closing
		expect(await readdir(store.entriesDir)).toEqual([])
		expect(() => store.install(['alpha@1.0.0'])).toThrow('closed')
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
		expect(result.failed[0]?.message).toBe(
			'pnpm could not prepare the managed dependency graph; published installations remain available',
		)
		await expect(readFile(resolve(rootDir, 'published-installation.json'))).rejects.toMatchObject({
			code: 'ENOENT',
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

		await expect(store.initialize()).rejects.toThrow('immutable published installation')
		expect(await readdir(store.entriesDir)).toEqual([])
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
