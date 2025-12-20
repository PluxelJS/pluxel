import { describe, expect, it } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { normalize, resolve } from 'pathe'
import type { Context } from '@pluxel/core'
import { resolveBareImport } from '../src/services/hmr/workspace-resolver'
import { ScanService, type ScanServiceConfig } from '../src/services/market/ScanService'

const fixtureRoot = normalize(
	fileURLToPath(new URL('./fixtures/scan/workspace-cross/', import.meta.url)),
)
const kookEntry = resolve(fixtureRoot, 'chatbots/kook/src/kook.ts')
const HMR_CONDITIONS = ['@pluxel/hmr', '@pluxel/source', 'import', 'module', 'default']

function createScanService(overrides: ScanServiceConfig = {}) {
	return new ScanService({} as Context, {
		roots: fixtureRoot,
		installedBase: fixtureRoot,
		options: { preferHmrExports: true },
		...overrides,
	})
}

describe('workspace resolver', () => {
	it('resolves bare specifiers from sibling workspace packages', async () => {
		const scanService = createScanService()
		const result = await resolveBareImport({
			specifier: 'pluxel-plugin-wretch',
			importer: kookEntry,
			scanService,
			conditions: HMR_CONDITIONS,
			fallbackBaseDirs: [fixtureRoot],
		})

		expect(result?.replace(/\\/g, '/')).toMatch(/packages\/wretch\/src\/wretch\.ts$/)
	})

	it('prefers @pluxel/hmr exports even when default comes first', async () => {
		const scanService = createScanService()
		const result = await resolveBareImport({
			specifier: 'pluxel-plugin-default-first',
			importer: kookEntry,
			scanService,
			conditions: HMR_CONDITIONS,
			fallbackBaseDirs: [fixtureRoot],
		})

		expect(result?.replace(/\\/g, '/')).toMatch(/packages\/default-first\/src\/index\.ts$/)
	})

	it('falls back to installed node_modules when scan service is not provided', async () => {
		const result = await resolveBareImport({
			specifier: 'pluxel-plugin-wretch',
			importer: kookEntry,
			conditions: HMR_CONDITIONS,
			fallbackBaseDirs: [fixtureRoot],
		})

		expect(result?.replace(/\\/g, '/')).toMatch(/packages\/wretch\/src\/wretch\.ts$/)
	})

	it('ignores non-bare specifiers', async () => {
		const scanService = createScanService()
		const result = await resolveBareImport({
			specifier: './relative/path',
			importer: kookEntry,
			scanService,
			conditions: HMR_CONDITIONS,
			fallbackBaseDirs: [fixtureRoot],
		})
		expect(result).toBeNull()
	})
})
