import { describe, expect, it } from 'vitest'
import { resolveLoaderHmrDependencies } from '../../src/hmr/engine/config'

describe('HMR bridgeProviders', () => {
	it('always includes @pluxel/context and maps it to @pluxel/core by default', () => {
		const deps = resolveLoaderHmrDependencies()
		expect(deps.bridgeModules.includes('@pluxel/context')).toBe(true)
		expect(deps.bridgeModules.includes('@pluxel/runtime/internal')).toBe(true)
		expect(deps.bridgeProviders['@pluxel/context']).toBe('@pluxel/core')
	})

	it('only appends CJS external rules to the runtime defaults', () => {
		const deps = resolveLoaderHmrDependencies({ cjsExternal: ['legacy-cjs'] })
		expect(deps.cjsExternal).toEqual(
			expect.arrayContaining(['pluxel-plugin-napi-rs/*', '@napi-rs/*', 'legacy-cjs']),
		)
	})
})
