import { describe, expect, it } from 'bun:test'
import { fileURLToPath } from 'node:url'
import type { Context } from '@pluxel/core'
import { normalize } from 'pathe'
import { type EntryResolutionOk, ScanService } from '../src/services/market/ScanService'

const fixtureRoot = normalize(fileURLToPath(new URL('./fixtures/scan/single/', import.meta.url)))
const tsOnlyRoot = normalize(fileURLToPath(new URL('./fixtures/scan/ts-only/', import.meta.url)))

function createService(overrides: Partial<ConstructorParameters<typeof ScanService>[1]> = {}) {
	return new ScanService({} as Context, {
		roots: fixtureRoot,
		installedBase: fixtureRoot,
		...overrides,
	})
}

function asPosix(input: string) {
	return input.replace(/\\+/g, '/')
}

describe('ScanService', () => {
	it('resolves entry by package name inside workspace', async () => {
		const service = createService()
		const resolution = await service.resolveEntryByName('scan-single-fixture')

		expect(resolution.ok).toBe(true)
		expect(asPosix((resolution as EntryResolutionOk).entry)).toMatch(/lib\/index\.js$/)
	})

	it('falls back to installed packages when not in workspace', async () => {
		const service = createService()
		const resolution = await service.resolveEntry('pathe')

		expect(resolution.ok).toBe(true)
		expect(asPosix((resolution as EntryResolutionOk).entry)).toContain('node_modules/pathe')
	})

	it('can skip installed fallback when workspaceOnly is true', async () => {
		const service = createService()
		const resolution = await service.resolveEntry('pathe', { workspaceOnly: true })

		expect(resolution.ok).toBe(false)
	})

	it('directly resolves installed package entries', async () => {
		const service = createService()
		const resolution = await service.resolveInstalledEntry('pathe')

		expect(resolution.ok).toBe(true)
		expect(asPosix((resolution as EntryResolutionOk).entry)).toContain('node_modules/pathe')
	})

	it('accepts directory selectors for workspace packages', async () => {
		const service = createService()
		const resolution = await service.resolveEntry({ dir: fixtureRoot })

		expect(resolution?.ok).toBe(true)
		expect(asPosix((resolution as EntryResolutionOk).entry)).toMatch(/lib\/index\.js$/)
	})

	it('lists workspace entries scoped by roots', async () => {
		const service = createService()
		const entries = await service.listWorkspaceEntries({ roots: fixtureRoot })

		expect(entries.length).toBeGreaterThan(0)
		expect(asPosix(entries[0].entry)).toMatch(/lib\/index\.js$/)
	})
})

describe('ScanService without package.json (ts-only)', () => {
	function createTsOnlyService() {
		return new ScanService({} as Context, {
			roots: tsOnlyRoot,
			installedBase: tsOnlyRoot,
			options: {
				fallbackTsOnSingle: true,
			},
		})
	}

	it('resolves index.ts as fallback entry', async () => {
		const service = createTsOnlyService()
		const entry = await service.resolveEntry({ dir: tsOnlyRoot })
		expect(entry.ok).toBe(true)
		if (entry.ok) {
			expect(asPosix(entry.entry)).toMatch(/\/ts-only\/index\.ts$/)
		}
	})
})
