import { describe, expect, it } from 'vitest'
import { resolveDynamicRuntimeEntry } from '../src/entry.ts'

describe('dynamic Runtime entry normalization', () => {
	it('resolves strings from the caller-owned base and file URLs directly', () => {
		expect(
			resolveDynamicRuntimeEntry('./src/pluxel.dynamic.ts', '/workspace', 'test-boundary'),
		).toBe('/workspace/src/pluxel.dynamic.ts')
		expect(
			resolveDynamicRuntimeEntry(
				new URL('file:///fixtures/pluxel.dynamic.ts'),
				'/ignored',
				'test-boundary',
			),
		).toBe('/fixtures/pluxel.dynamic.ts')
	})

	it('rejects ambiguous or unsupported module locators', () => {
		expect(() => resolveDynamicRuntimeEntry(' ', '/workspace', 'test-boundary')).toThrow(
			/entry is required/i,
		)
		expect(() =>
			resolveDynamicRuntimeEntry(
				new URL('https://example.test/pluxel.dynamic.ts'),
				'/workspace',
				'test-boundary',
			),
		).toThrow(/file: protocol/i)
		expect(() =>
			resolveDynamicRuntimeEntry(
				new URL('file:///pluxel.dynamic.ts#latest'),
				'/workspace',
				'test-boundary',
			),
		).toThrow(/query or fragment/i)
	})
})
