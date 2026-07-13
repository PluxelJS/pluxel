import { describe, expect, it, vi } from 'vitest'
import { ProjectedCollection } from '../src/projected-collection.ts'

type Status = { id: string; value: number }

describe('ProjectedCollection', () => {
	it('owns business state before a management projection is attached', () => {
		const collection = new ProjectedCollection<Status>()
		collection.insert({ id: 'status', value: 1 })
		collection.replaceOne({ id: 'status' }, { id: 'status', value: 2 })

		expect(collection.findOne({ id: 'status' })).toEqual({ id: 'status', value: 2 })
	})

	it('mirrors the snapshot and later mutations when management is enabled', async () => {
		const collection = new ProjectedCollection<Status>()
		collection.insert({ id: 'status', value: 1 })
		const projection = {
			ready: vi.fn(async () => undefined),
			insert: vi.fn(),
			replaceOne: vi.fn(),
			removeOne: vi.fn(),
			removeMany: vi.fn(),
		}

		await collection.attach(projection)
		collection.replaceOne({ id: 'status' }, { id: 'status', value: 2 })

		expect(projection.removeMany).toHaveBeenCalledWith({})
		expect(projection.replaceOne).toHaveBeenNthCalledWith(
			1,
			{ id: 'status' },
			{ id: 'status', value: 1 },
			{ upsert: true },
		)
		expect(projection.replaceOne).toHaveBeenCalledWith(
			{ id: 'status' },
			{ id: 'status', value: 2 },
			{},
		)
	})

	it('keeps optional projection failures out of business writes', async () => {
		const collection = new ProjectedCollection<Status>()
		const projection = {
			ready: vi.fn(async () => undefined),
			insert: vi.fn(),
			replaceOne: vi.fn().mockRejectedValue(new Error('stale projection row')),
			removeOne: vi.fn(),
			removeMany: vi.fn(async () => undefined),
		}

		await collection.attach(projection)
		expect(() => collection.insert({ id: 'status', value: 1 })).not.toThrow()
		expect(collection.findOne({ id: 'status' })).toEqual({ id: 'status', value: 1 })
	})

	it('rejects replacements that would corrupt the id index', () => {
		const collection = new ProjectedCollection<Status>()

		expect(() =>
			collection.replaceOne({ id: 'status' }, { id: 'other', value: 1 }, { upsert: true }),
		).toThrow(/does not match/)
	})
})
