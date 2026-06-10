import { describe, expect, test } from 'vitest'
import { createFixture } from '@pluxel/test/fixtures'
import { EntryResolver } from '../../../runtime-dynamic/src/scan/entry-resolver'
import { ModuleResolveCache } from '../../../runtime-dynamic/src/scan/resolve-cache'
import type { ResolvedScanOptions } from '../../../runtime-dynamic/src/scan/types'

const baseOptions: ResolvedScanOptions = {
	conditions: ['node', 'import'],
	conservativeCandidates: ['dist/wretch.mjs'],
	preferRuntimeDynamicExports: false,
	includeRoot: false,
	skipUnnamed: false,
	fallbackTsOnSingle: false,
	batchSize: 1,
	focusPackages: undefined,
}

const cache = new ModuleResolveCache()

describe('EntryResolver preferRuntimeDynamicExports', () => {
	const fixtureTree = {
		'package.json': JSON.stringify(
			{
				name: 'pluxel-plugin-wretch',
				exports: {
					'.': {
						'@pluxel/runtime-dynamic': './src/wretch.ts',
						default: './dist/wretch.mjs',
					},
				},
			},
			null,
			2,
		),
		'src/wretch.ts': '// loader HMR entry',
		'dist/wretch.mjs': '// bundled entry',
	}

	test('prefers @pluxel/runtime-dynamic export when enabled', async () => {
		await using fixture = await createFixture(fixtureTree)
		const resolver = new EntryResolver(cache, fixture.fs)
		const options: ResolvedScanOptions = { ...baseOptions, preferRuntimeDynamicExports: true }
		const result = await resolver.resolve(fixture.path, options)
		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error('expected entry resolution to succeed')
		expect(result.entry.replaceAll('\\', '/').endsWith('/src/wretch.ts')).toBe(true)
	})

	test('falls back to default export when disabled', async () => {
		await using fixture = await createFixture(fixtureTree)
		const resolver = new EntryResolver(cache, fixture.fs)
		const options: ResolvedScanOptions = { ...baseOptions, preferRuntimeDynamicExports: false }
		const result = await resolver.resolve(fixture.path, options)
		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error('expected entry resolution to succeed')
		expect(result.entry.replaceAll('\\', '/').endsWith('/dist/wretch.mjs')).toBe(true)
	})
})
