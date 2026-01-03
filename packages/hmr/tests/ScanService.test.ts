import { describe, expect, it } from 'bun:test'
import type { Context } from '@pluxel/core'
import { createFixture } from 'fs-fixture'
import { normalize } from 'pathe'
import { type EntryResolutionOk, ScanService } from '../src/services/market/ScanService'

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

const scanTsOnlyFixture = {
	'index.ts': "export const hello = 'ts-only'\n",
} satisfies Record<string, string>

function createService(
	root: string,
	overrides: Partial<ConstructorParameters<typeof ScanService>[1]> = {},
) {
	return new ScanService({} as Context, {
		roots: root,
		installedBase: root,
		...overrides,
	})
}

function asPosix(input: string) {
	return input.replace(/\\+/g, '/')
}

describe('ScanService', () => {
	it('resolves entry by package name inside workspace', async () => {
		await using fixture = await createFixture(scanSingleFixture)
		const service = createService(normalize(fixture.path))
		const resolution = await service.resolveEntryByName('scan-single-fixture')

		expect(resolution.ok).toBe(true)
		expect(asPosix((resolution as EntryResolutionOk).entry)).toMatch(/lib\/index\.js$/)
	})

	it('falls back to installed packages when not in workspace', async () => {
		await using fixture = await createFixture(scanSingleFixture)
		const service = createService(normalize(fixture.path))
		const resolution = await service.resolveEntry('pathe')

		expect(resolution.ok).toBe(true)
		expect(asPosix((resolution as EntryResolutionOk).entry)).toContain('node_modules/pathe')
	})

	it('can skip installed fallback when workspaceOnly is true', async () => {
		await using fixture = await createFixture(scanSingleFixture)
		const service = createService(normalize(fixture.path))
		const resolution = await service.resolveEntry('pathe', { workspaceOnly: true })

		expect(resolution.ok).toBe(false)
	})

	it('directly resolves installed package entries', async () => {
		await using fixture = await createFixture(scanSingleFixture)
		const service = createService(normalize(fixture.path))
		const resolution = await service.resolveInstalledEntry('pathe')

		expect(resolution.ok).toBe(true)
		expect(asPosix((resolution as EntryResolutionOk).entry)).toContain('node_modules/pathe')
	})

	it('accepts directory selectors for workspace packages', async () => {
		await using fixture = await createFixture(scanSingleFixture)
		const fixtureRoot = normalize(fixture.path)
		const service = createService(fixtureRoot)
		const resolution = await service.resolveEntry({ dir: fixtureRoot })

		expect(resolution?.ok).toBe(true)
		expect(asPosix((resolution as EntryResolutionOk).entry)).toMatch(/lib\/index\.js$/)
	})

	it('lists workspace entries scoped by roots', async () => {
		await using fixture = await createFixture(scanSingleFixture)
		const fixtureRoot = normalize(fixture.path)
		const service = createService(fixtureRoot)
		const entries = await service.listWorkspaceEntries({ roots: fixtureRoot })

		expect(entries.length).toBeGreaterThan(0)
		expect(asPosix(entries[0].entry)).toMatch(/lib\/index\.js$/)
	})
})

describe('ScanService without package.json (ts-only)', () => {
	it('resolves index.ts as fallback entry', async () => {
		await using fixture = await createFixture(scanTsOnlyFixture)
		const tsOnlyRoot = normalize(fixture.path)
		const service = createService(tsOnlyRoot, {
			options: { fallbackTsOnSingle: true },
		})
		const entry = await service.resolveEntry({ dir: tsOnlyRoot })
		expect(entry.ok).toBe(true)
		if (entry.ok) {
			expect(asPosix(entry.entry)).toMatch(/\/index\.ts$/)
		}
	})
})
