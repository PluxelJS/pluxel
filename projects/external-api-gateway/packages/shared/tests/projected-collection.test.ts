import { describe, expect, it, vi } from 'vitest'
import { ProjectedCollection } from '../src/projected-collection.ts'

type Status = { id: string; value: number }

describe('ProjectedCollection', () => {
	it('owns business state and exposes an immutable snapshot', () => {
		const collection = new ProjectedCollection<Status>()
		collection.insert({ id: 'status', value: 1 })
		collection.replaceOne({ id: 'status' }, { id: 'status', value: 2 })

		expect(collection.findOne({ id: 'status' })).toEqual({ id: 'status', value: 2 })
		expect(collection.snapshot()).toEqual([{ id: 'status', value: 2 }])
	})

	it('invalidates Workbench projections after mutations', () => {
		const collection = new ProjectedCollection<Status>()
		const invalidate = vi.fn()
		const dispose = collection.subscribe(invalidate)

		collection.insert({ id: 'status', value: 1 })
		collection.replaceOne({ id: 'status' }, { id: 'status', value: 2 })
		collection.removeOne({ id: 'status' })

		expect(invalidate).toHaveBeenCalledTimes(3)
		dispose()
		collection.insert({ id: 'other', value: 3 })
		expect(invalidate).toHaveBeenCalledTimes(3)
	})

	it('rejects replacements that would corrupt the id index', () => {
		const collection = new ProjectedCollection<Status>()

		expect(() =>
			collection.replaceOne({ id: 'status' }, { id: 'other', value: 1 }, { upsert: true }),
		).toThrow(/does not match/)
	})
})
