import { describe, expect, it } from 'vitest'
import oxlintPlugin, {
	PLUXEL_OXLINT_PACKAGE_SPECIFIER,
	createPluxelJsPluginEntry,
	pluxelOxlintIgnorePatterns,
} from '../src/oxlint'

describe('@pluxel/test/oxlint', () => {
	it('re-exports the workspace oxlint entry from source', () => {
		expect(oxlintPlugin).toBeTypeOf('object')
		expect(createPluxelJsPluginEntry()).toEqual({
			name: 'pluxel',
			specifier: PLUXEL_OXLINT_PACKAGE_SPECIFIER,
		})
		expect(pluxelOxlintIgnorePatterns).toContain('**/dist/**')
	})
})
