import { afterEach, describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'pathe'
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
const resolver = new EntryResolver(cache)

let workdir = mkdtempSync(resolve(tmpdir(), 'hmr-entry-test-'))
afterEach(() => {
	rmSync(workdir, { recursive: true, force: true })
	workdir = mkdtempSync(resolve(tmpdir(), 'hmr-entry-test-'))
})

describe('EntryResolver preferHmrExports', () => {
	function writeFixture() {
		mkdirSync(resolve(workdir, 'src'), { recursive: true })
		mkdirSync(resolve(workdir, 'dist'), { recursive: true })
		writeFileSync(
			resolve(workdir, 'package.json'),
			JSON.stringify(
				{
					name: 'pluxel-plugin-wretch',
					exports: {
						'.': {
							'@pluxel/runtime': './src/wretch.ts',
							default: './dist/wretch.mjs',
						},
					},
				},
				null,
				2,
			),
		)
		writeFileSync(resolve(workdir, 'src', 'wretch.ts'), '// hmr entry')
		writeFileSync(resolve(workdir, 'dist', 'wretch.mjs'), '// bundled entry')
	}

	test('prefers @pluxel/runtime export when enabled', async () => {
		writeFixture()
		const options: ResolvedScanOptions = { ...baseOptions, preferHmrExports: true }
		const result = await resolver.resolve(workdir, options)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.entry.replace(/\\/g, '/').endsWith('/src/wretch.ts')).toBe(true)
		}
	})

	test('falls back to default export when disabled', async () => {
		writeFixture()
		const options: ResolvedScanOptions = { ...baseOptions, preferHmrExports: false }
		const result = await resolver.resolve(workdir, options)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.entry.replace(/\\/g, '/').endsWith('/dist/wretch.mjs')).toBe(true)
		}
	})
})
