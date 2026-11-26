import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { InstallOptions, InstallResult, ParsedBareSpecifier } from '@pnpm/napi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PnpmEngine } from '../src/pnpm-engine.ts'
import { PluginSourceBusyError, type PluginSourceImpact } from '@pluxel/host/sources'
import {
	packageMutationLimit,
	type MarketInstallRequest,
	type MarketRelease,
} from '../src/contracts.ts'
import { ManagedPackageStore } from '../src/store.ts'

const roots: string[] = []

afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<string> {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-package-manager-'))
	roots.push(root)
	return root
}

function createEngine(
	pluginFields: Record<string, unknown> = {
		peerDependencies: { '@pluxel/core': '*' },
		exports: './index.mjs',
	},
) {
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
				JSON.stringify({
					...pluginFields,
					name,
					version: requested.replace(/^[^0-9]*/, '') || '1.0.0',
				}),
			)
			await writeFile(resolve(directory, 'index.mjs'), 'export default 1')
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
				packages: Object.fromEntries(
					keys.map((key) => [
						key,
						{
							resolution: {
								integrity: `sha512-${createHash('sha512').update(key).digest('base64')}`,
							},
						},
					]),
				),
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
		resolveDependency: vi.fn(async () => {
			throw new Error('Unexpected metadata lookup')
		}),
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

function checkedRelease({ name, version, registry }: MarketInstallRequest): MarketRelease {
	return {
		name,
		version,
		registry,
		integrity: `sha512-${createHash('sha512').update(`${name}@${version}`).digest('base64')}`,
		checkedAt: 1,
		provenance: { status: 'missing' },
		peerDependencies: {},
		pluginPackages: {},
		readme: null,
		license: null,
	}
}

describe('ManagedPackageStore', () => {
	it('rejects an application-owned package on both entry points and a busy Host before confirmation', async () => {
		const rootDir = await fixtureRoot()
		const readHostImpact = vi.fn<() => PluginSourceImpact>().mockReturnValue({
			catalogRevision: 1,
			policyRevision: 0,
			definitions: [
				{
					packageName: 'alpha',
					origin: 'fixed',
					nodes: [],
					address: {
						entry: { kind: 'package-root', packageName: 'alpha' },
						exportName: 'Provider',
					},
				},
			],
		})
		const store = new ManagedPackageStore(createEngine().engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
			readHostImpact,
		})
		await store.initialize()
		try {
			for (const result of [
				await store.prepareInstall(['alpha@1.0.0']),
				await store.install(['alpha@1.0.0']),
			])
				expect(result).toMatchObject({
					ok: false,
					failed: [
						{
							code: 'SOURCE_CONFLICT',
							message: expect.stringContaining('package:alpha::Provider'),
						},
					],
				})
			readHostImpact.mockReturnValue({ catalogRevision: 2, policyRevision: 0, definitions: [] })
			const prepared = await store.prepareInstall(['alpha@1.0.0'])
			if (!prepared.ok)
				throw new Error('Expected review for the package without a control manifest')
			expect(prepared.plan.hostImpact).toEqual([
				{ name: 'alpha', definitionsKnown: false, definitions: [] },
			])
			readHostImpact.mockImplementationOnce(() => {
				throw new PluginSourceBusyError()
			})
			expect(await store.confirmInstall(prepared.plan.id)).toMatchObject({
				ok: false,
				failed: [{ code: 'HOST_GRAPH_BUSY' }],
			})
			expect(await store.snapshot()).toMatchObject({ revision: 0, packages: [] })
			expect(await readdir(store.entriesDir)).toEqual([])
			expect(await readdir(resolve(rootDir, 'revisions'))).toEqual([])
		} finally {
			await store.close()
		}
	})

	it('requires another review before repairing an entry that changed outside the reviewed publication', async () => {
		const rootDir = await fixtureRoot()
		const store = new ManagedPackageStore(createEngine().engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
		})
		await store.initialize()
		try {
			expect(await store.install(['alpha@1.0.0', 'beta@1.0.0'])).toMatchObject({ ok: true })
			const old = await store.snapshot()
			const betaEntry = resolve(
				store.entriesDir,
				old.packages.find(({ name }) => name === 'beta')!.entryFile!,
			)
			const prepared = await store.prepareInstall(['alpha@2.0.0'])
			if (!prepared.ok) throw new Error('Expected alpha upgrade')
			await rm(betaEntry)
			expect(await store.confirmInstall(prepared.plan.id)).toMatchObject({
				ok: false,
				failed: [{ code: 'INVALID_PLAN', message: expect.stringContaining('beta') }],
			})
			expect(await store.snapshot()).toMatchObject({
				revision: old.revision,
				packages: [
					{ name: 'alpha', installedVersion: '1.0.0' },
					{ name: 'beta', entryFile: null },
				],
			})
			const repair = await store.prepareInstall(['alpha@2.0.0'])
			if (!repair.ok) throw new Error('Expected reviewed repair')
			expect(repair.plan.packages).toMatchObject([
				{ name: 'alpha', changed: true },
				{ name: 'beta', changed: true },
			])
			expect(await store.confirmInstall(repair.plan.id)).toMatchObject({
				ok: true,
				succeeded: ['alpha'],
				published: ['alpha', 'beta'],
				withdrawn: [],
			})
			await expect(stat(betaEntry)).resolves.toBeDefined()
		} finally {
			await store.close()
		}
	})

	it('prepares a fixed private installation and confirms its same bytes without repeating acquisition', async () => {
		const rootDir = await fixtureRoot()
		const { engine, install } = createEngine()
		const store = new ManagedPackageStore(engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
			sourceUpdates: 'next-start',
		})
		await store.initialize()
		try {
			const result = await store.prepareInstall(['alpha@^1.2.0'])
			expect(result.ok).toBe(true)
			if (!result.ok) throw new Error('Expected prepared installation')
			expect(result.plan).toMatchObject({
				baseRevision: 0,
				sourceUpdates: 'next-start',
				requested: ['alpha'],
				packages: [{ name: 'alpha', version: '1.2.0', previousVersion: null, changed: true }],
			})
			expect(result.plan.packages[0]!.integrity).toMatch(/^sha512-/)
			expect(await readdir(store.entriesDir)).toEqual([])
			expect(await store.snapshot()).toMatchObject({ revision: 0, packages: [], markets: [] })
			expect(await store.confirmInstall(result.plan.id)).toEqual({
				ok: true,
				succeeded: ['alpha'],
				failed: [],
				published: ['alpha'],
				withdrawn: [],
			})
			expect(install).toHaveBeenCalledTimes(1)
			expect(await store.snapshot()).toMatchObject({
				revision: 1,
				packages: [
					{
						name: 'alpha',
						requested: '1.2.0',
						installedVersion: '1.2.0',
						entryFile: expect.any(String),
					},
				],
			})
			expect(await store.confirmInstall(result.plan.id)).toMatchObject({
				ok: false,
				failed: [{ code: 'INVALID_PLAN' }],
				published: [],
				withdrawn: [],
			})
		} finally {
			await store.close()
		}
	})

	it('rejects an entire invalid preview before acquisition and replaces only successfully parsed candidates', async () => {
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
			expect(
				await store.prepareInstall(['alpha@1.0.0', 'https://invalid/package.tgz']),
			).toMatchObject({ ok: false, failed: [{ code: 'INVALID_SPEC' }] })
			expect(install).not.toHaveBeenCalled()
			const first = await store.prepareInstall(['alpha@1.0.0'])
			const second = await store.prepareInstall(['beta@2.0.0'])
			if (!first.ok || !second.ok) throw new Error('Expected prepared installations')
			expect(await readdir(resolve(rootDir, 'revisions'))).toHaveLength(1)
			expect(await store.confirmInstall(first.plan.id)).toMatchObject({
				ok: false,
				failed: [{ code: 'INVALID_PLAN' }],
			})
			expect(await store.confirmInstall(second.plan.id)).toMatchObject({
				ok: true,
				succeeded: ['beta'],
			})
		} finally {
			await store.close()
		}
	})

	it('invalidates a preview after another mutation and after expiry without publishing it', async () => {
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
			const prepared = await store.prepareInstall(['alpha@1.0.0'])
			if (!prepared.ok) throw new Error('Expected prepared installation')
			await store.install(['beta@1.0.0'])
			expect(await store.confirmInstall(prepared.plan.id)).toMatchObject({
				ok: false,
				failed: [{ code: 'INVALID_PLAN' }],
			})
			const expired = await store.prepareInstall(['alpha@1.0.0'])
			if (!expired.ok) throw new Error('Expected prepared installation')
			vi.spyOn(Date, 'now').mockReturnValue(expired.plan.expiresAt)
			expect(await store.confirmInstall(expired.plan.id)).toMatchObject({
				ok: false,
				failed: [{ code: 'INVALID_PLAN' }],
			})
			const snapshot = await store.snapshot()
			expect(snapshot.packages.map(({ name }) => name)).toEqual(['beta'])
		} finally {
			await store.close()
		}
	})

	it('rejects modified prepared bytes and removes an unpublished revision on close', async () => {
		const rootDir = await fixtureRoot()
		const { engine } = createEngine()
		const store = new ManagedPackageStore(engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
		})
		await store.initialize()
		const prepared = await store.prepareInstall(['alpha@1.0.0'])
		if (!prepared.ok) throw new Error('Expected prepared installation')
		await writeFile(resolve(rootDir, 'slots/alpha-1.0.0/node_modules/alpha/injected.js'), 'changed')
		expect(await store.confirmInstall(prepared.plan.id)).toMatchObject({
			ok: false,
			succeeded: [],
			failed: [{ code: 'INSTALL_FAILED' }],
			published: [],
			withdrawn: [],
		})
		expect(await readdir(store.entriesDir)).toEqual([])
		expect(await readdir(resolve(rootDir, 'revisions'))).toEqual([])
		await store.prepareInstall(['beta@1.0.0'])
		await store.close()
		expect(await readdir(resolve(rootDir, 'revisions'))).toEqual([])
	})

	it('checks every selected market release and confirms the whole reviewed selection once', async () => {
		const rootDir = await fixtureRoot()
		const { engine, install } = createEngine()
		const store = new ManagedPackageStore(engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
			markets: [{ id: 'community', url: 'https://market.example' }],
		})
		await store.initialize()
		const fetch = vi.spyOn(globalThis, 'fetch')
		const alpha = {
			marketId: 'community',
			name: 'alpha',
			version: '1.0.0',
			registry: 'https://registry.npmjs.org',
		}
		const beta = { ...alpha, name: 'beta', version: '2.1.0-rc.1' }
		try {
			fetch.mockResolvedValueOnce(Response.json(checkedRelease(alpha))).mockResolvedValueOnce(
				Response.json({
					...checkedRelease(beta),
					integrity: `sha512-${createHash('sha512').update('different').digest('base64')}`,
					tarball: 'https://attacker.invalid/code.tgz',
				}),
			)
			expect(await store.prepareMarketInstall([alpha, beta])).toMatchObject({
				ok: false,
				failed: [
					{
						input: 'beta@2.1.0-rc.1',
						code: 'INSTALL_FAILED',
						message: expect.stringContaining('integrity'),
					},
				],
			})
			expect(await readdir(store.entriesDir)).toEqual([])
			expect(await store.snapshot()).toMatchObject({ revision: 0, packages: [] })
			expect(install).toHaveBeenCalledTimes(1)
			fetch
				.mockResolvedValueOnce(Response.json(checkedRelease(alpha)))
				.mockRejectedValueOnce(new Error('offline'))
			expect(await store.prepareMarketInstall([alpha, beta])).toMatchObject({
				ok: false,
				failed: [{ input: 'beta@2.1.0-rc.1', code: 'MARKET_FAILED' }],
			})
			expect(install).toHaveBeenCalledTimes(1)
			const direct = await store.prepareInstall(['alpha@0.9.0'])
			if (!direct.ok) throw new Error('Expected direct preparation')
			expect(await store.confirmInstall(direct.plan.id)).toMatchObject({ ok: true })
			expect(fetch).toHaveBeenCalledTimes(4)

			const before = await store.snapshot()
			const releases = [{ ...alpha }, { ...beta }]
			fetch
				.mockResolvedValueOnce(Response.json(checkedRelease(alpha)))
				.mockResolvedValueOnce(Response.json(checkedRelease(beta)))
			const preparing = store.prepareMarketInstall(releases)
			releases[1]!.version = '9.0.0'
			releases.splice(0, 1)
			const selected = await preparing
			if (selected.ok === false) throw new Error(selected.failed[0]?.message)
			const market = { marketId: alpha.marketId, registry: alpha.registry }
			expect(selected.plan.packages).toMatchObject([
				{ name: 'alpha', previousVersion: '0.9.0', version: alpha.version, market },
				{ name: 'beta', previousVersion: null, version: beta.version, market },
			])
			expect(await store.snapshot()).toEqual(before)
			expect(await store.confirmInstall(selected.plan.id)).toEqual({
				ok: true,
				succeeded: ['alpha', 'beta'],
				failed: [],
				published: ['alpha', 'beta'],
				withdrawn: [],
			})
			expect(await store.confirmInstall(selected.plan.id)).toMatchObject({
				ok: false,
				failed: [{ code: 'INVALID_PLAN' }],
			})
			expect(install).toHaveBeenCalledTimes(3)
			expect(await store.snapshot()).toMatchObject({
				revision: before.revision + 1,
				packages: [
					{ name: 'alpha', installedVersion: alpha.version, entryFile: expect.any(String) },
					{ name: 'beta', installedVersion: beta.version, entryFile: expect.any(String) },
				],
			})
		} finally {
			await store.close()
		}
	})

	it('reviews cascading checked plugins through an npm mirror, including ranges, cycles and compatible alternatives', async () => {
		const rootDir = await fixtureRoot()
		const { engine, install } = createEngine()
		const config = engine.readConfig({ dir: rootDir })
		vi.spyOn(engine, 'readConfig').mockReturnValue({
			...config,
			registries: [{ name: 'default', url: 'https://registry.npmmirror.com/' }],
		})
		const store = new ManagedPackageStore(engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
			markets: [{ id: 'community', url: 'https://market.example' }],
		})
		await store.initialize()
		const registry = 'https://registry.npmjs.org'
		const root = { marketId: 'community', registry, name: 'root', version: '1.0.0' }
		const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = new URL(String(input))
			expect(url.searchParams.get('registry')).toBe(registry)
			const [, , , name, , version] = url.pathname.split('/')
			if (!version) {
				const list = name === 'codec' ? ['2.0.0', '1.10.0', '1.2.0'] : ['1.0.0']
				return Response.json({
					releases: list.map((candidate) => checkedRelease({ ...root, name, version: candidate })),
					coverage: 'indexed-only',
					nextCursor: null,
				})
			}
			const result = checkedRelease({ ...root, name, version })
			if (name === 'root')
				return Response.json({
					...result,
					pluginPackages: { codec: 'required', logger: 'optional', bridge: 'required' },
					peerDependencies: { codec: '>=1', logger: '^3', bridge: '^1', 'plain-peer': '*' },
				})
			if (name === 'bridge')
				return Response.json({
					...result,
					pluginPackages: { codec: 'required', root: 'required' },
					peerDependencies: { codec: '^1', root: '^1' },
				})
			return Response.json(result)
		})
		try {
			const preview = await store.prepareMarketInstall([root])
			if (preview.ok === false) throw new Error(preview.failed[0]?.message)
			expect(preview.plan.packages.map((pkg) => pkg.name).sort()).toEqual([
				'bridge',
				'codec',
				'root',
			])
			expect(preview.plan.packages.find((pkg) => pkg.name === 'codec')).toMatchObject({
				version: '1.10.0',
				market: { registry },
				requiredBy: [
					{ name: 'root', range: '>=1' },
					{ name: 'bridge', range: '^1' },
				],
			})
			expect(await readdir(store.entriesDir)).toEqual([])
			expect(install.mock.calls[0]![0].registries?.default).toBe('https://registry.npmmirror.com/')
			expect(await store.confirmInstall(preview.plan.id)).toMatchObject({ ok: true })
			const confirmed = await store.snapshot()
			expect(confirmed.packages).toHaveLength(3)
			expect(fetch.mock.calls.map(([url]) => String(url)).join(' ')).not.toMatch(
				/logger|plain-peer/,
			)
			const conflict = await store.prepareMarketInstall([
				root,
				{ ...root, name: 'codec', version: '2.0.0' },
			])
			expect(conflict).toMatchObject({
				ok: false,
				failed: [{ input: 'codec', message: expect.stringContaining('bridge') }],
			})
			expect(install).toHaveBeenCalledTimes(1)
		} finally {
			await store.close()
		}
	})

	it('rejects invalid or conflicting market selections before reading or materializing any release', async () => {
		const { engine, install } = createEngine()
		const store = new ManagedPackageStore(engine, {
			rootDir: await fixtureRoot(),
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
			markets: [{ id: 'community', url: 'https://market.example' }],
		})
		await store.initialize()
		const select = {
			marketId: 'community',
			registry: 'https://registry.npmjs.org',
			name: 'alpha',
			version: '1.0.0',
		}
		const fetch = vi.spyOn(globalThis, 'fetch')
		try {
			for (const requests of [
				[],
				[{ ...select, version: 'latest' }],
				[select, { ...select, version: '2.0.0' }],
				[select, { ...select, marketId: 'another', registry: 'https://another.example' }],
				Array.from({ length: packageMutationLimit + 1 }, (_, index) => ({
					...select,
					name: `alpha-${index}`,
				})),
			]) {
				expect(await store.prepareMarketInstall(requests)).toMatchObject({
					ok: false,
					failed: [{ code: 'INVALID_SPEC' }],
				})
			}
			expect(fetch).not.toHaveBeenCalled()
			expect(install).not.toHaveBeenCalled()
			expect(await store.snapshot()).toMatchObject({ revision: 0, packages: [] })
		} finally {
			await store.close()
		}
	})

	it('preserves per-release sources across markets and rejects a scoped registry mismatch for the entire batch', async () => {
		const rootDir = await fixtureRoot()
		const { engine, install } = createEngine()
		const store = new ManagedPackageStore(engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
			markets: [
				{ id: 'community', url: 'https://market.example' },
				{ id: 'team', url: 'https://team.example' },
			],
		})
		await store.initialize()
		const request = {
			marketId: 'team',
			registry: 'http://127.0.0.1:7677/npm',
			name: '@example/plugin',
			version: '1.0.0',
		}
		const publicRequest = {
			marketId: 'community',
			registry: 'https://registry.npmjs.org',
			name: 'alpha',
			version: '2.0.0',
		}
		const selections = [publicRequest, request]
		const release = checkedRelease(request)
		const fetch = vi.spyOn(globalThis, 'fetch')
		try {
			fetch
				.mockResolvedValueOnce(Response.json(checkedRelease(publicRequest)))
				.mockResolvedValueOnce(
					Response.json({ ...release, registry: 'https://registry.npmjs.org' }),
				)
			expect(await store.prepareMarketInstall(selections)).toMatchObject({
				ok: false,
				failed: [{ input: '@example/plugin@1.0.0', code: 'MARKET_FAILED' }],
			})
			expect(install).not.toHaveBeenCalled()
			fetch
				.mockResolvedValueOnce(Response.json(checkedRelease(publicRequest)))
				.mockResolvedValueOnce(Response.json(release))
			expect(await store.prepareMarketInstall(selections)).toMatchObject({
				ok: false,
				failed: [
					{
						input: '@example/plugin@1.0.0',
						code: 'INSTALL_FAILED',
						message: expect.stringContaining('same registry'),
					},
				],
			})
			expect(install).not.toHaveBeenCalled()
			expect(await readdir(store.entriesDir)).toEqual([])
			const config = engine.readConfig({ dir: rootDir })
			const registryConfig = vi.spyOn(engine, 'readConfig').mockReturnValue({
				...config,
				registries: [...config.registries, { name: '@example', url: `${request.registry}/` }],
			})
			fetch
				.mockResolvedValueOnce(Response.json(checkedRelease(publicRequest)))
				.mockResolvedValueOnce(Response.json(release))
			const prepared = await store.prepareMarketInstall(selections)
			expect(prepared.ok).toBe(true)
			if (prepared.ok === false) throw new Error(prepared.failed[0]?.message)
			expect(prepared.plan.packages.map(({ name, market }) => [name, market])).toEqual([
				[request.name, { marketId: request.marketId, registry: request.registry }],
				[
					publicRequest.name,
					{ marketId: publicRequest.marketId, registry: publicRequest.registry },
				],
			])
			expect(install).toHaveBeenCalledTimes(1)
			expect(install.mock.calls[0]![0].registries?.['@example']).toBe(`${request.registry}/`)
			expect(await store.confirmInstall(prepared.plan.id)).toMatchObject({ ok: true })
			expect(install).toHaveBeenCalledTimes(1)
			const installed = await store.snapshot()
			expect(installed.packages).toMatchObject([
				{ name: request.name, marketRegistry: request.registry },
				{ name: publicRequest.name, marketRegistry: publicRequest.registry },
			])

			// A different registry can serve the same exact archive for the same scoped name.
			const other = { ...request, registry: publicRequest.registry }
			registryConfig.mockReturnValue(config)
			fetch.mockResolvedValueOnce(Response.json(checkedRelease(other)))
			const switchSource = await store.prepareMarketInstall([other])
			if (switchSource.ok === false) throw new Error(switchSource.failed[0]?.message)
			expect(switchSource.plan.packages[0]).toMatchObject({
				name: request.name,
				previousVersion: request.version,
				version: request.version,
				previousMarketRegistry: request.registry,
				market: { registry: other.registry },
				changed: true,
			})
			expect(await store.snapshot()).toEqual(installed)
			expect(await store.confirmInstall(switchSource.plan.id)).toMatchObject({ ok: true })
			const switched = await store.snapshot()
			expect(switched.packages[0]?.marketRegistry).toBe(other.registry)

			// A direct graph change loses its source claim. Unchanged packages retain their evidence.
			expect(await store.install([publicRequest.name + '@3.0.0'])).toMatchObject({ ok: true })
			const direct = await store.snapshot()
			expect(direct.packages[0]?.marketRegistry).toBe(other.registry)
			expect(direct.packages[1]).not.toHaveProperty('marketRegistry')
			const unverified = { ...publicRequest, version: '3.0.0' }
			fetch.mockResolvedValueOnce(Response.json(checkedRelease(unverified)))
			const verify = await store.prepareMarketInstall([unverified])
			if (verify.ok === false) throw new Error(verify.failed[0]?.message)
			expect(verify.plan.packages[1]).toMatchObject({
				name: publicRequest.name,
				previousVersion: unverified.version,
				changed: true,
				market: { registry: unverified.registry },
			})
			expect(verify.plan.packages[1]).not.toHaveProperty('previousMarketRegistry')
			expect(await store.snapshot()).toEqual(direct)
		} finally {
			await store.close()
		}
	})

	it('accepts published records without a market source and rejects malformed recorded registries', async () => {
		const rootDir = await fixtureRoot()
		const { engine } = createEngine()
		const options = {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [] as string[],
			minimumReleaseAgeMinutes: 0,
		}
		const store = new ManagedPackageStore(engine, options)
		await store.initialize()
		try {
			expect(await store.install(['alpha@1.0.0'])).toMatchObject({ ok: true })
		} finally {
			await store.close()
		}
		const reopened = new ManagedPackageStore(engine, options)
		await reopened.initialize()
		try {
			const legacy = await reopened.snapshot()
			expect(legacy.packages[0]).not.toHaveProperty('marketRegistry')
		} finally {
			await reopened.close()
		}
		const file = resolve(rootDir, 'published-installation.json')
		const record = JSON.parse(await readFile(file, 'utf8'))
		for (const field of [
			null,
			'https://registry.example/',
			'https://registry.example/pack?token=x',
			'https://user@registry.example',
		]) {
			record.packages[0].marketRegistry = field
			await writeFile(file, JSON.stringify(record))
			await expect(new ManagedPackageStore(engine, options).initialize()).rejects.toThrow(
				'Invalid managed published package',
			)
		}
	})

	it('retains committed selection and partial source publication when confirmation cannot publish every wrapper', async () => {
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
			const prepared = await store.prepareInstall(['alpha@1.0.0', 'beta@1.0.0'])
			if (prepared.ok === false) throw new Error(prepared.failed[0]?.message)
			await mkdir(resolve(store.entriesDir, Buffer.from('beta').toString('base64url') + '.mjs'))
			expect(await store.confirmInstall(prepared.plan.id)).toMatchObject({
				ok: false,
				succeeded: ['alpha'],
				failed: [{ input: 'beta', code: 'INSTALL_FAILED' }],
				published: ['alpha'],
				withdrawn: [],
			})
			const snapshot = await store.snapshot()
			expect(snapshot).toMatchObject({
				revision: 1,
				packages: [
					{ name: 'alpha', entryFile: expect.any(String) },
					{ name: 'beta', entryFile: null },
				],
			})
			expect(await readdir(resolve(rootDir, 'revisions'))).toHaveLength(1)
			expect(await store.confirmInstall(prepared.plan.id)).toMatchObject({
				ok: false,
				failed: [{ code: 'INVALID_PLAN' }],
			})
		} finally {
			await store.close()
		}
	})

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

	it('reports the requested package and the reviewed withdrawal separately through failure and retry', async () => {
		const rootDir = await fixtureRoot()
		const { engine } = createEngine()
		const store = new ManagedPackageStore(engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
			readHostImpact: () => ({ catalogRevision: 1, policyRevision: 1, definitions: [] }),
		})
		await store.initialize()
		try {
			const betaEntry = resolve(
				store.entriesDir,
				Buffer.from('beta').toString('base64url') + '.mjs',
			)
			expect(await store.install(['beta@1.0.0'])).toMatchObject({ ok: true })
			const original = await readFile(betaEntry)
			await rm(betaEntry)
			await mkdir(betaEntry)
			expect(await store.remove(['beta'])).toMatchObject({
				ok: false,
				failed: [{ input: 'beta', code: 'REMOVE_FAILED' }],
			})
			expect(await store.snapshot()).toMatchObject({ packages: [], pendingRemovals: ['beta'] })

			const prepared = await store.prepareInstall(['alpha@1.0.0'])
			if (prepared.ok === false) throw new Error(prepared.failed[0]?.message)
			expect(prepared.plan.hostImpact?.map(({ name }) => name).sort()).toEqual(['alpha', 'beta'])
			expect(await store.confirmInstall(prepared.plan.id)).toMatchObject({
				ok: false,
				succeeded: ['alpha'],
				failed: [{ input: 'beta', code: 'INSTALL_FAILED' }],
				published: ['alpha'],
				withdrawn: [],
			})
			expect(await store.snapshot()).toMatchObject({
				packages: [{ name: 'alpha', entryFile: expect.any(String) }],
				pendingRemovals: ['beta'],
			})
			await rm(betaEntry, { recursive: true })
			await writeFile(betaEntry, original)
			const retry = await store.prepareInstall(['alpha@1.0.0'])
			if (retry.ok === false) throw new Error(retry.failed[0]?.message)
			expect(retry.plan.pendingRemovals).toEqual(['beta'])
			expect(await store.confirmInstall(retry.plan.id)).toEqual({
				ok: true,
				succeeded: ['alpha'],
				failed: [],
				published: [],
				withdrawn: ['beta'],
			})
			await expect(stat(betaEntry)).rejects.toMatchObject({ code: 'ENOENT' })
			expect(await store.snapshot()).toMatchObject({ pendingRemovals: [] })
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
			expect(afterFailure.pendingRemovals).toEqual(['alpha'])
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
			expect(afterRetry.pendingRemovals).toEqual([])
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

	it('publishes build-script diagnostics with the accepted installation only', async () => {
		const rootDir = await fixtureRoot()
		const { engine, install } = createEngine()
		const nativeInstall = install.getMockImplementation()!
		const store = new ManagedPackageStore(engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
		})
		await store.initialize()
		try {
			install.mockImplementationOnce(async (options) => ({
				...(await nativeInstall(options)),
				depsRequiringBuild: ['alpha'],
			}))
			expect(await store.install(['alpha@1.0.0'])).toMatchObject({ ok: true })
			install.mockImplementationOnce(async (options) => {
				const result = await nativeInstall(options)
				await writeFile(resolve(options.dir, 'pnpm-lock.yaml'), '{}')
				return { ...result, depsRequiringBuild: ['beta'] }
			})
			expect(await store.install(['beta@1.0.0'])).toMatchObject({ ok: false })
			expect(await store.snapshot()).toMatchObject({
				revision: 1,
				dependenciesWithBuildScripts: ['alpha'],
			})
			expect(await store.remove(['alpha'])).toMatchObject({ ok: true })
			expect(await store.snapshot()).toMatchObject({ dependenciesWithBuildScripts: [] })
		} finally {
			await store.close()
		}
	})

	it('reads one settled snapshot between admitted mutations', async () => {
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
			const installing = store.install(['alpha@1.0.0'])
			const reading = store.snapshot()
			const removing = store.remove(['alpha'])
			expect(await installing).toMatchObject({ ok: true })
			expect(await reading).toMatchObject({
				revision: 1,
				packages: [{ name: 'alpha', installedVersion: '1.0.0', entryFile: expect.any(String) }],
				pendingRemovals: [],
			})
			expect(await removing).toMatchObject({ ok: true })
			expect(await store.snapshot()).toMatchObject({ revision: 2, packages: [] })
		} finally {
			await store.close()
		}
		expect(() => store.snapshot()).toThrow('closed')
	})

	it('drains initialization before releasing writer ownership on repeated close', async () => {
		const rootDir = await fixtureRoot()
		const { engine } = createEngine()
		const store = new ManagedPackageStore(engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
		})
		const entered = Promise.withResolvers<void>()
		const finish = Promise.withResolvers<undefined>()
		vi.spyOn(
			store as unknown as { readInstallation(): Promise<undefined> },
			'readInstallation',
		).mockImplementationOnce(() => {
			entered.resolve()
			return finish.promise
		})
		const initializing = store.initialize()
		const outcome = initializing.catch((error: unknown) => error)
		await entered.promise
		const closing = store.close()
		expect(store.close()).toBe(closing)
		let settled = false
		void closing.then((): void => {
			settled = true
			return undefined
		})
		await Promise.resolve()
		expect(settled).toBe(false)
		finish.resolve(undefined)
		await expect(outcome).resolves.toMatchObject({ message: 'Package store is closed' })
		await closing
		await expect(stat(resolve(rootDir, '.writer'))).rejects.toMatchObject({ code: 'ENOENT' })
	})

	it('checks the reviewed removal revision after previously admitted writes settle', async () => {
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
			await store.install(['alpha@1.0.0'])
			const reviewed = await store.snapshot()
			const update = store.install(['alpha@2.0.0'])
			const removal = store.remove(['alpha'], reviewed.revision)
			expect(await update).toMatchObject({ ok: true })
			expect(await removal).toMatchObject({
				ok: false,
				succeeded: [],
				failed: [{ code: 'REMOVE_FAILED' }],
			})
			expect(install).toHaveBeenCalledTimes(2)
			const current = await store.snapshot()
			expect(current.packages).toMatchObject([{ name: 'alpha', installedVersion: '2.0.0' }])
			expect(await store.remove(['alpha'], current.revision)).toMatchObject({
				ok: true,
				succeeded: ['alpha'],
			})
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

it.each([
	[{}, '@pluxel/core'],
	[
		{ peerDependencies: { '@pluxel/core': '*' }, exports: './missing.mjs' },
		'Missing published package file',
	],
	[
		{
			peerDependencies: { '@pluxel/core': '*' },
			exports: './index.mjs',
			pluxel: { control: './package.json' },
		},
		'Control manifest contains unexpected or missing fields',
	],
] as const)(
	'rejects incompatible installed bytes in review and immediate installation',
	async (fields, reason) => {
		const rootDir = await fixtureRoot()
		const { engine } = createEngine(fields)
		const store = new ManagedPackageStore(engine, {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
		})
		await store.initialize()
		try {
			for (const result of [
				await store.prepareInstall(['ordinary@1.0.0']),
				await store.install(['ordinary@1.0.0']),
			]) {
				expect(result).toMatchObject({
					ok: false,
					failed: [{ message: expect.stringContaining(reason) }],
				})
				expect(await store.snapshot()).toMatchObject({ revision: 0, packages: [] })
				expect(await readdir(store.entriesDir)).toEqual([])
			}
		} finally {
			await store.close()
		}
	},
)
