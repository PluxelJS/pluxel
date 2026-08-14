import { describe, expect, it } from 'vitest'
import { RuntimeShimRegistry, SHIM_REFLECT_METADATA } from '../src/hmr/engine/runtime-shims'

describe('runtime shims', () => {
	it('resolves exact, prefix, custom, and disabled shim declarations', () => {
		const reg = new RuntimeShimRegistry({ shims: SHIM_REFLECT_METADATA })

		const r1 = reg.resolveId('reflect-metadata')
		expect(r1).toBeTruthy()
		expect(r1!.id.startsWith('\0pluxel:hmr:shim:')).toBe(true)
		expect(r1!.moduleSideEffects).toBe(false)
		expect(reg.load(r1!.id)).toBe('export {}')

		const r2 = reg.resolveId('reflect-metadata/Reflect')
		expect(r2).toBeTruthy()
		expect(reg.load(r2!.id)).toBe('export {}')

		const custom = new RuntimeShimRegistry({
			shims: {
				foo: { code: 'export const x = 1', moduleSideEffects: false, exports: { x: 1 } },
				'foo/*': { code: 'export const prefix = true' },
				'bar/*': true,
				disabled: false,
			},
		})

		const foo = custom.resolveId('foo')
		expect(foo!.id.startsWith('\0pluxel:hmr:shim:')).toBe(true)
		expect(custom.load(foo!.id)).toBe('export const x = 1')
		expect(custom.require('foo')).toEqual({ x: 1 })
		expect(custom.load(custom.resolveId('foo/child')!.id)).toBe('export const prefix = true')

		const bar = custom.resolveId('bar/baz')
		expect(bar!.id.startsWith('\0pluxel:hmr:shim:')).toBe(true)
		expect(custom.load(bar!.id)).toBe('export {}')
		expect(custom.require('bar/baz')).toEqual({})

		expect(custom.resolveId('bar')).toBeNull()
		expect(custom.resolveId('disabled')).toBeNull()
	})
})
