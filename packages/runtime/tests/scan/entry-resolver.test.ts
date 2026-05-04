import { describe, expect, test } from 'vitest'
import { createFixture } from '@pluxel/test/fixtures'
import { EntryResolver } from '../../src/services/runtime/scan/entry-resolver'
import { ModuleResolveCache } from '../../src/services/runtime/scan/resolve-cache'
import type { ResolvedScanOptions } from '../../src/services/runtime/scan/types'

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

const cache = new ModuleResolveCache()

describe('EntryResolver preferHmrExports', () => {
	const fixtureTree = {
		'package.json': JSON.stringify(
			{
				name: 'pluxel-plugin-wretch',
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
		'src/wretch.ts': '// hmr entry',
		'dist/wretch.mjs': '// bundled entry',
	}

	test('prefers @pluxel/hmr export when enabled', async () => {
		await using fixture = await createFixture(fixtureTree)
		const resolver = new EntryResolver(cache, fixture.fs)
		const options: ResolvedScanOptions = { ...baseOptions, preferHmrExports: true }
		const result = await resolver.resolve(fixture.path, options)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.entry.replaceAll('\\', '/').endsWith('/src/wretch.ts')).toBe(true)
		}
	})

	test('falls back to default export when disabled', async () => {
		await using fixture = await createFixture(fixtureTree)
		const resolver = new EntryResolver(cache, fixture.fs)
		const options: ResolvedScanOptions = { ...baseOptions, preferHmrExports: false }
		const result = await resolver.resolve(fixture.path, options)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.entry.replaceAll('\\', '/').endsWith('/dist/wretch.mjs')).toBe(true)
		}
	})
})
