import { describe, expect, it } from 'vitest'
import {
	clearSieveState,
	getOrCreateCachedValue,
	getOrCreatePromise,
} from '../../src/services/runtime/shared/cache'

describe('runtime/shared cache (sieve)', () => {
	it('evicts unreferenced entries first (cached value)', () => {
		const map = new Map<string, number>()

		getOrCreateCachedValue(map, 'a', () => 1, { limit: 2 })
		getOrCreateCachedValue(map, 'b', () => 2, { limit: 2 })
		clearSieveState(map)

		// Only `a` gets a second chance.
		expect(
			getOrCreateCachedValue(
				map,
				'a',
				() => {
					throw new Error('should not create')
				},
				{ limit: 2 },
			),
		).toBe(1)

		getOrCreateCachedValue(map, 'c', () => 3, { limit: 2 })

		expect([...map.keys()]).toEqual(['a', 'c'])
	})

	it('evicts unreferenced entries first (promise)', async () => {
		const map = new Map<string, Promise<number>>()

		await getOrCreatePromise(map, 'a', async () => 1, { limit: 2 })
		await getOrCreatePromise(map, 'b', async () => 2, { limit: 2 })
		clearSieveState(map)

		// Only `a` gets a second chance.
		await getOrCreatePromise(
			map,
			'a',
			async () => {
				throw new Error('should not create')
			},
			{ limit: 2 },
		)

		await getOrCreatePromise(map, 'c', async () => 3, { limit: 2 })

		expect([...map.keys()]).toEqual(['a', 'c'])
	})

	it('does not cache when evictIf is true', async () => {
		const map = new Map<string, Promise<string | null>>()

		await getOrCreatePromise(map, 'miss', async () => null, {
			limit: 2,
			evictIf: (v) => v == null,
		})

		expect(map.has('miss')).toBe(false)
	})
})
