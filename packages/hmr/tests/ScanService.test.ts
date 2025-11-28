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
		...overrides,
	})
}

function asPosix(input: string) {
	return input.replace(/\\+/g, '/')
}

describe('ScanService', () => {
	it('builds snapshot for single package root', async () => {
		const service = createService()
		const snapshot = await service.snapshot()

		expect(snapshot.packages.length).toBe(1)
		const pkg = snapshot.packages[0]
		expect(pkg.name).toBe('scan-single-fixture')
		expect(pkg.entry.ok).toBe(true)
		expect(asPosix((pkg.entry as EntryResolutionOk).entry)).toMatch(/lib\/index\.js$/)

		expect(snapshot.entries).toHaveLength(1)
		expect(asPosix(snapshot.entries[0])).toMatch(/lib\/index\.js$/)
	})

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
})

describe('ScanService without package.json (ts-only)', () => {
	function createTsOnlyService() {
		return new ScanService({} as Context, {
			roots: tsOnlyRoot,
			options: {
				fallbackTsOnSingle: true,
			},
		})
	}

	it('resolves index.ts as fallback entry', async () => {
		const service = createTsOnlyService()
		const snapshot = await service.snapshot()

		expect(snapshot.entries).toHaveLength(1)
		const entry = snapshot.entries[0]
		expect(asPosix(entry)).toMatch(/\/ts-only\/index\.ts$/)

		const pkg = snapshot.packages[0]
		expect(pkg.entry.ok).toBe(true)
		if (pkg.entry.ok) {
			expect(asPosix(pkg.entry.entry)).toMatch(/\/ts-only\/index\.ts$/)
		}
	})
})
