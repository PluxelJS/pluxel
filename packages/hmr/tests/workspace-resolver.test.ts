import { describe, expect, it } from 'bun:test'
import { normalize, resolve } from 'pathe'
import type { Context } from '@pluxel/core'
import { createFixture } from 'fs-fixture'
import { resolveBareImport } from '../src/services/hmr/workspace-resolver'
import { ScanService, type ScanServiceConfig } from '../src/services/market/ScanService'

const HMR_CONDITIONS = ['@pluxel/hmr', '@pluxel/source', 'import', 'module', 'default']

const workspaceFixture = {
	'pnpm-workspace.yaml': ['packages:', '  - chatbots/*', '  - packages/*', ''].join('\n'),
	'packages/wretch/package.json': JSON.stringify(
		{
			name: 'pluxel-plugin-wretch',
			version: '0.1.0',
			type: 'module',
			exports: {
				'.': {
					'@pluxel/hmr': './src/wretch.ts',
					default: './dist/wretch.mjs',
				},
			},
		},
		null,
		2,
	),
	'packages/wretch/src/wretch.ts': "export const wretchPlugin = 'wretch-fixture'\n",
	'packages/wretch/dist/wretch.mjs': "export const built = 'dist-version'\n",
	'packages/default-first/package.json': JSON.stringify(
		{
			name: 'pluxel-plugin-default-first',
			version: '0.1.0',
			type: 'module',
			exports: {
				'.': {
					default: './dist/index.mjs',
					'@pluxel/hmr': './src/index.ts',
				},
			},
		},
		null,
		2,
	),
	'packages/default-first/src/index.ts': "export const entry = 'hmr'\n",
	'packages/default-first/dist/index.mjs': "export const entry = 'dist'\n",
	'chatbots/kook/package.json': JSON.stringify(
		{
			name: 'pluxel-plugin-kook',
			version: '0.1.0',
			type: 'module',
			exports: {
				'.': {
					'@pluxel/hmr': './src/kook.ts',
					default: './dist/kook.mjs',
				},
			},
			peerDependencies: {
				'pluxel-plugin-wretch': 'workspace:*',
			},
		},
		null,
		2,
	),
	'chatbots/kook/src/kook.ts': [
		"import { wretchPlugin } from 'pluxel-plugin-wretch'",
		'export const kookDep = wretchPlugin',
		'',
	].join('\n'),
	'node_modules/pluxel-plugin-wretch/package.json': JSON.stringify(
		{
			name: 'pluxel-plugin-wretch',
			version: '0.1.0',
			type: 'module',
			exports: {
				'.': {
					'@pluxel/hmr': './src/wretch.ts',
					default: './dist/wretch.mjs',
				},
			},
		},
		null,
		2,
	),
	'node_modules/pluxel-plugin-wretch/src/wretch.ts': "export const wretchPlugin = 'wretch-fixture'\n",
} satisfies Record<string, string>

function createScanService(root: string, overrides: ScanServiceConfig = {}) {
	return new ScanService({} as Context, {
		roots: root,
		installedBase: root,
		options: { preferHmrExports: true },
		...overrides,
	})
}

describe('workspace resolver', () => {
	it('resolves bare specifiers from sibling workspace packages', async () => {
		await using fixture = await createFixture(workspaceFixture)
		const fixtureRoot = normalize(fixture.path)
		const kookEntry = resolve(fixtureRoot, 'chatbots/kook/src/kook.ts')
		const scanService = createScanService(fixtureRoot)
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
		await using fixture = await createFixture(workspaceFixture)
		const fixtureRoot = normalize(fixture.path)
		const kookEntry = resolve(fixtureRoot, 'chatbots/kook/src/kook.ts')
		const scanService = createScanService(fixtureRoot)
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
		await using fixture = await createFixture(workspaceFixture)
		const fixtureRoot = normalize(fixture.path)
		const kookEntry = resolve(fixtureRoot, 'chatbots/kook/src/kook.ts')
		const result = await resolveBareImport({
			specifier: 'pluxel-plugin-wretch',
			importer: kookEntry,
			conditions: HMR_CONDITIONS,
			fallbackBaseDirs: [fixtureRoot],
		})
		expect(result?.replace(/\\/g, '/')).toMatch(/node_modules\/pluxel-plugin-wretch\/src\/wretch\.ts$/)
	})

	it('ignores non-bare specifiers', async () => {
		await using fixture = await createFixture(workspaceFixture)
		const fixtureRoot = normalize(fixture.path)
		const kookEntry = resolve(fixtureRoot, 'chatbots/kook/src/kook.ts')
		const scanService = createScanService(fixtureRoot)
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
