import { describe, expect, test } from 'vitest'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { normalize } from 'pathe'
import { getOxcResolveCache } from '@pluxel/runtime/internal'
import { EntryResolver } from '../../src/scan/entry-resolver'
import type { ResolvedScanOptions } from '../../src/scan/types'

const baseOptions: ResolvedScanOptions = {
	conditions: ['node', 'import'],
	conservativeCandidates: ['dist/wretch.mjs'],
	preferHmrExports: false,
	includeRoot: false,
	skipUnnamed: false,
	fallbackTsOnSingle: false,
	batchSize: 1,
	focusPackages: undefined,
}

const cache = getOxcResolveCache(new Map())

describe('EntryResolver preferHmrExports', () => {
	const fixtureTree = {
		'package.json': JSON.stringify(
			{
				name: 'pluxel-plugin-wretch',
				exports: {
					'.': {
						'@pluxel/hmr': './src/hmr.ts',
						default: './dist/wretch.mjs',
					},
				},
			},
			null,
			2,
		),
		'src/hmr.ts': '// loader HMR entry',
		'dist/wretch.mjs': '// bundled entry',
	}

	test('prefers @pluxel/hmr export through OXC conditions when enabled', async () => {
		await using fixture = await createDiskFixture(fixtureTree)
		const resolver = new EntryResolver(cache, fixture.fs)
		const options: ResolvedScanOptions = { ...baseOptions, preferHmrExports: true }
		const result = await resolver.resolve(fixture.path, options)
		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error('expected entry resolution to succeed')
		expect(normalize(result.entry).endsWith('/src/hmr.ts')).toBe(true)
	})

	test('falls back to default export when disabled', async () => {
		await using fixture = await createDiskFixture(fixtureTree)
		const resolver = new EntryResolver(cache, fixture.fs)
		const options: ResolvedScanOptions = { ...baseOptions, preferHmrExports: false }
		const result = await resolver.resolve(fixture.path, options)
		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error('expected entry resolution to succeed')
		expect(normalize(result.entry).endsWith('/dist/wretch.mjs')).toBe(true)
	})
})
