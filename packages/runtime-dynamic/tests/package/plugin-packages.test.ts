import { describe, expect, it } from 'vitest'
import { parsePluginPackages } from '../../src/package/helpers'

describe('plugin package manifest schema', () => {
	it('preserves required and optional facts without overlap', () => {
		expect(
			parsePluginPackages({
				'pluxel-plugin-z': 'optional',
				'pluxel-plugin-a': 'required',
				invalid: 'soft',
			}),
		).toEqual({
			'pluxel-plugin-a': 'required',
			'pluxel-plugin-z': 'optional',
		})
	})
})
