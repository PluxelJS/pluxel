import { describe, expect, it } from 'vitest'
import { RuntimeShimRegistry, SHIM_REFLECT_METADATA } from '../src/dev/hmr/runtime-shims'

describe('runtime shims', () => {
	it('shims reflect-metadata (exact + prefix)', () => {
		const reg = new RuntimeShimRegistry({ shims: SHIM_REFLECT_METADATA })

		const r1 = reg.resolveId('reflect-metadata')
		expect(r1).toBeTruthy()
		expect(r1!.id.startsWith('\0pluxel:hmr:shim:')).toBe(true)
		expect(r1!.moduleSideEffects).toBe(false)
		expect(reg.load(r1!.id)).toBe('export {}')

		const r2 = reg.resolveId('reflect-metadata/Reflect')
		expect(r2).toBeTruthy()
		expect(reg.load(r2!.id)).toBe('export {}')
	})

	it('supports exact and prefix shims with custom code', () => {
		const reg = new RuntimeShimRegistry({
			shims: {
				foo: { code: 'export const x = 1', moduleSideEffects: false, exports: { x: 1 } },
				'bar/*': true,
			},
		})

		const foo = reg.resolveId('foo')
		expect(foo!.id.startsWith('\0pluxel:hmr:shim:')).toBe(true)
		expect(reg.load(foo!.id)).toBe('export const x = 1')
		expect(reg.require('foo')).toEqual({ x: 1 })

		const bar = reg.resolveId('bar/baz')
		expect(bar!.id.startsWith('\0pluxel:hmr:shim:')).toBe(true)
		expect(reg.load(bar!.id)).toBe('export {}')
		expect(reg.require('bar/baz')).toEqual({})

		expect(reg.resolveId('bar')).toBeNull()
	})

	it('prefers exact match over prefix match', () => {
		const reg = new RuntimeShimRegistry({
			shims: {
				foo: { code: 'export const exact = true' },
				'foo/*': { code: 'export const prefix = true' },
			},
		})

		const exact = reg.resolveId('foo')!
		expect(reg.load(exact.id)).toBe('export const exact = true')

		const pref = reg.resolveId('foo/bar')!
		expect(reg.load(pref.id)).toBe('export const prefix = true')
	})

	it('ignores disabled shims', () => {
		const reg = new RuntimeShimRegistry({
			shims: {
				foo: false,
			},
		})
		expect(reg.resolveId('foo')).toBeNull()
	})
})
