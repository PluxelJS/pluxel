import { describe, expect, it } from 'vitest'
import { isNotNullOrUndefined } from 'option-t/maybe'
import { fromSnapshot, tryFromSnapshot } from '../../src/package/specifiers'

describe('package specifier snapshots', () => {
	it('offers Maybe and throwing snapshot restore APIs', () => {
		const valid = tryFromSnapshot({
			name: 'pluxel-plugin-a',
			requested: 'pluxel-plugin-a',
		})
		expect(isNotNullOrUndefined(valid)).toBe(true)
		if (!valid) throw new Error('expected valid snapshot')
		expect(valid.name).toBe('pluxel-plugin-a')

		const invalid = { name: '', requested: '' }
		expect(tryFromSnapshot(invalid)).toBeUndefined()
		expect(() => fromSnapshot(invalid)).toThrow(/snapshot is empty/i)
	})
})
