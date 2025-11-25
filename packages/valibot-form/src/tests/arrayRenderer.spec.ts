import { describe, expect, it } from 'vitest'
import { reorderList } from '../web/components/renders/array'

describe('array renderer helpers', () => {
	it('reorders list within bounds', () => {
		const list = ['a', 'b', 'c', 'd']
		expect(reorderList(list, 1, 3)).toEqual(['a', 'c', 'd', 'b'])
		expect(reorderList(list, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
	})

	it('returns copy when indexes are invalid or equal', () => {
		const list = [1, 2, 3]
		expect(reorderList(list, 0, 0)).toEqual([1, 2, 3])
		expect(reorderList(list, -1, 2)).toEqual([1, 2, 3])
		expect(reorderList(list, 1, 5)).toEqual([1, 2, 3])
	})
})
