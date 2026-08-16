import { describe, expect, it, vi } from 'vitest'
import { createHost } from '@pluxel/test'
import { createDiskFixture, createFixture } from '@pluxel/test/fixtures'
import { normalize } from 'pathe'
import { type EntryResolutionOk, ScanService } from '../../src/scan/ScanService'

const scanSingleFixture = {
	'package.json': JSON.stringify(
		{
			name: 'scan-single-fixture',
			version: '1.0.0',
			main: 'lib/index.js',
		},
		null,
		2,
	),
	'lib/index.js': "export const value = 'scan-single'\n",
	'node_modules/pathe/package.json': JSON.stringify(
		{
			name: 'pathe',
			version: '0.0.0',
			type: 'module',
			exports: {
				'.': './index.js',
			},
		},
		null,
		2,
	),
	'node_modules/pathe/index.js': "export const join = (...parts) => parts.join('/')\n",
} satisfies Record<string, string>

const hmrConditionFixture = {
	'package.json': JSON.stringify(
		{
			name: 'scan-hmr-condition-fixture',
			version: '1.0.0',
			type: 'module',
			exports: {
				'.': {
					'@pluxel/hmr': './src/index.ts',
					default: './dist/index.mjs',
				},
			},
		},
		null,
		2,
	),
	'src/index.ts': "export const source = 'hmr'\n",
	'dist/index.mjs': "export const source = 'dist'\n",
} satisfies Record<string, string>

const scanTsOnlyFixture = {
	'index.ts': "export const hello = 'ts-only'\n",
} satisfies Record<string, string>

function createService(
	root: string,
	overrides: Partial<ConstructorParameters<typeof ScanService>[1]> = {},
): ScanService & AsyncDisposable {
	const host = createHost()
	const service = new ScanService(host.ctx, {
		roots: root,
		installedBase: root,
		...overrides,
	})
	return Object.assign(service, {
		async [Symbol.asyncDispose]() {
			await host.dispose()
		},
	})
}

function asPosix(input: string) {
	return input.replaceAll(/\\+/g, '/')
}

describe('ScanService', () => {
	it('notifies explicit resolver invalidation subscribers', async () => {
		const internalEmit = vi.fn()
		await using service = createService('/tmp')
		const unsubscribe = service.subscribeResolverInvalidated(internalEmit)

		service.invalidateResolverCache({ by: 'test', reason: 'unit' })
		const detail = {
			by: 'test',
			reason: 'unit',
		}
		expect(internalEmit).toHaveBeenCalledWith(detail)
		unsubscribe()
		service.invalidateResolverCache({ by: 'test', reason: 'after-unsubscribe' })
		expect(internalEmit).toHaveBeenCalledTimes(1)
	})

	it('resolves entry by package name inside workspace', async () => {
		await using fixture = await createFixture(scanSingleFixture)
		await using service = createService(normalize(fixture.path), { fs: fixture.fs })
		const resolution = await service.resolveEntryByName('scan-single-fixture')

		expect(resolution.ok).toBe(true)
		expect(asPosix((resolution as EntryResolutionOk).entry)).toMatch(/lib\/index\.js$/)
	})

	it('does not use the HMR export condition for default package resolution', async () => {
		await using fixture = await createDiskFixture(hmrConditionFixture)
		await using service = createService(normalize(fixture.path))
		const resolution = await service.resolveEntryByName('scan-hmr-condition-fixture')

		expect(resolution.ok).toBe(true)
		expect(asPosix((resolution as EntryResolutionOk).entry)).toMatch(/dist\/index\.mjs$/)
	})

	it('uses the HMR export condition only when explicitly requested', async () => {
		await using fixture = await createDiskFixture(hmrConditionFixture)
		await using service = createService(normalize(fixture.path))
		const resolution = await service.resolveEntryByName('scan-hmr-condition-fixture', {
			scan: { preferHmrExports: true },
		})

		expect(resolution.ok).toBe(true)
		expect(asPosix((resolution as EntryResolutionOk).entry)).toMatch(/src\/index\.ts$/)
	})

	it('falls through to development before the framework source condition', async () => {
		await using fixture = await createDiskFixture({
			'package.json': JSON.stringify({
				name: 'scan-development-condition-fixture',
				exports: {
					'.': {
						development: './src/development.ts',
						'@pluxel/source': './src/source.ts',
						default: './dist/index.mjs',
					},
				},
			}),
			'src/development.ts': "export const source = 'development'\n",
			'src/source.ts': "export const source = 'source'\n",
			'dist/index.mjs': "export const source = 'dist'\n",
		})
		await using service = createService(normalize(fixture.path))
		const resolution = await service.resolveEntryByName('scan-development-condition-fixture', {
			scan: { preferHmrExports: true },
		})

		expect(resolution.ok).toBe(true)
		expect(asPosix((resolution as EntryResolutionOk).entry)).toMatch(/src\/development\.ts$/)
	})

	it('falls back to installed packages when not in workspace', async () => {
		await using fixture = await createDiskFixture(scanSingleFixture)
		await using service = createService(normalize(fixture.path))
		const resolution = await service.resolveEntry('pathe')

		expect(resolution.ok).toBe(true)
		expect(asPosix((resolution as EntryResolutionOk).entry)).toContain('node_modules/pathe')
	})

	it('can skip installed fallback when workspaceOnly is true', async () => {
		await using fixture = await createDiskFixture(scanSingleFixture)
		await using service = createService(normalize(fixture.path))
		const resolution = await service.resolveEntry('pathe', { workspaceOnly: true })

		expect(resolution.ok).toBe(false)
	})

	it('directly resolves installed package entries', async () => {
		await using fixture = await createDiskFixture(scanSingleFixture)
		await using service = createService(normalize(fixture.path))
		const resolution = await service.resolveInstalledEntry('pathe')

		expect(resolution.ok).toBe(true)
		expect(asPosix((resolution as EntryResolutionOk).entry)).toContain('node_modules/pathe')
	})

	it('accepts directory selectors for workspace packages', async () => {
		await using fixture = await createFixture(scanSingleFixture)
		const fixtureRoot = normalize(fixture.path)
		await using service = createService(fixtureRoot, { fs: fixture.fs })
		const resolution = await service.resolveEntry({ dir: fixtureRoot })

		expect(resolution?.ok).toBe(true)
		expect(asPosix((resolution as EntryResolutionOk).entry)).toMatch(/lib\/index\.js$/)
	})

	it('lists workspace entries scoped by roots', async () => {
		await using fixture = await createFixture(scanSingleFixture)
		const fixtureRoot = normalize(fixture.path)
		await using service = createService(fixtureRoot, { fs: fixture.fs })
		const entries = await service.listWorkspaceEntries({ roots: fixtureRoot })

		expect(entries.length).toBeGreaterThan(0)
		expect(asPosix(entries[0].entry)).toMatch(/lib\/index\.js$/)
	})

	it('resolves project-local workspace packages from nested pnpm patterns', async () => {
		await using fixture = await createDiskFixture({
			'package.json': JSON.stringify({ name: 'root', version: '1.0.0' }, null, 2),
			'pnpm-workspace.yaml': ['packages:', '  - projects/*/plugins/*', ''].join('\n'),
			'projects/example-app/plugins/billing/package.json': JSON.stringify(
				{
					name: '@repo/nested-fixture-billing',
					version: '0.0.0',
					type: 'module',
					exports: {
						'.': {
							'@pluxel/hmr': './src/index.ts',
							default: './dist/index.mjs',
						},
					},
				},
				null,
				2,
			),
			'projects/example-app/plugins/billing/src/index.ts':
				"export const source = 'billing-source'\n",
			'projects/example-app/plugins/billing/dist/index.mjs':
				"export const source = 'billing-dist'\n",
		})
		const fixtureRoot = normalize(fixture.path)
		await using service = createService(fixtureRoot)

		const resolution = await service.resolveEntryByName('@repo/nested-fixture-billing', {
			workspaceOnly: true,
			scan: { preferHmrExports: true },
		})

		expect(resolution.ok).toBe(true)
		expect(asPosix((resolution as EntryResolutionOk).entry)).toMatch(
			/projects\/example-app\/plugins\/billing\/src\/index\.ts$/,
		)
	})

	it('can swap to a virtual scan fs via updateConfig', async () => {
		await using diskFixture = await createDiskFixture({})
		await using virtualFixture = await createFixture(scanSingleFixture)

		await using service = createService(normalize(diskFixture.path))
		service.updateConfig({ roots: normalize(virtualFixture.path), fs: virtualFixture.fs })

		const resolution = await service.resolveEntryByName('scan-single-fixture')
		expect(resolution.ok).toBe(true)
		expect(asPosix((resolution as EntryResolutionOk).entry)).toMatch(/lib\/index\.js$/)
	})

	it('rebuilds installed resolver when installedBase changes', async () => {
		await using emptyFixture = await createDiskFixture({
			'package.json': JSON.stringify({ name: 'empty-root', version: '1.0.0' }, null, 2),
		})
		await using installedFixture = await createDiskFixture(scanSingleFixture)

		await using service = createService(normalize(emptyFixture.path))
		const initialResolution = await service.resolveInstalledEntry('pathe')
		expect(initialResolution.ok).toBe(false)

		service.updateConfig({ installedBase: normalize(installedFixture.path) })
		const resolution = await service.resolveInstalledEntry('pathe')

		expect(resolution.ok).toBe(true)
		expect(asPosix((resolution as EntryResolutionOk).entry)).toContain('node_modules/pathe')
	})
})

describe('ScanService without package.json (ts-only)', () => {
	it('resolves index.ts as fallback entry', async () => {
		await using fixture = await createFixture(scanTsOnlyFixture)
		const tsOnlyRoot = normalize(fixture.path)
		await using service = createService(tsOnlyRoot, {
			fs: fixture.fs,
			options: { fallbackTsOnSingle: true },
		})
		const entry = await service.resolveEntry({ dir: tsOnlyRoot })
		expect(entry.ok).toBe(true)
		if (!entry.ok) throw new Error('expected fallback entry resolution to succeed')
		expect(asPosix(entry.entry)).toMatch(/\/index\.ts$/)
	})
})
