import { describe, expect, it } from 'vitest'
import { LOADER_HMR_BRIDGE_MODULES, LOADER_HMR_BRIDGE_PROVIDERS } from '../../src/hmr/engine/config'

describe('HMR bridgeProviders', () => {
	it('always includes @pluxel/context and maps it to @pluxel/core by default', () => {
		expect(LOADER_HMR_BRIDGE_MODULES.includes('@pluxel/context')).toBe(true)
		expect(LOADER_HMR_BRIDGE_MODULES.includes('@pluxel/runtime/internal')).toBe(true)
		expect(LOADER_HMR_BRIDGE_PROVIDERS['@pluxel/context']).toBe('@pluxel/core')
	})
})
