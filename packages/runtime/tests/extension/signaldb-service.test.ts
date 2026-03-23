import { describe, expect, it, vi } from 'vitest'
import { SignalDbService } from '../../src/services/plugin-interaction/SignalDbService'

function createFakeCtx() {
	const ctx: any = {
		pluginInfo: { id: 'test-plugin' },
		effects: {
			defer: (fn: () => void) => ({ dispose: fn }),
		},
		ext: {
			sse: {
				expose: vi.fn(() => () => undefined),
			},
		},
		pluginData: {
			persistenceForCollection: vi.fn(async () => ({
				load: async () => ({ items: [] }),
				save: async () => {},
				register: async () => {},
				unregister: async () => {},
			})),
		},
	}
	return ctx
}

describe('SignalDbService', () => {
	it('collection.watch() receives client and server-side mutations', async () => {
		const ctx = createFakeCtx()
		const service = new SignalDbService(ctx)
		const collection = service.collection<{ id: string; value: number }>({
			name: 'runtime-actions',
			persistence: false,
			clientWrites: true,
		})
		await collection.ready()

		const events: string[] = []
		const stop = collection.watch((event) => {
			events.push(event.type)
		})

		collection.insert({ id: 'a', value: 1 })
		collection.updateOne({ id: 'a' }, { $set: { value: 2 } })
		await service.applyCollectionSyncChanges('runtime-actions', {
			removed: [{ id: 'a', value: 2 }],
		})
		stop()

		expect(events).toEqual(['insert', 'update', 'remove'])
	})

	it('creates persistence-backed collections without a transient adapter-less instance', async () => {
		const ctx = createFakeCtx()
		const service = new SignalDbService(ctx)
		const collection = service.collection<{ id: string; value: number }>({
			name: 'persisted-runtime-actions',
		})

		await collection.ready()
		collection.insert({ id: 'a', value: 1 })

		expect(ctx.pluginData.persistenceForCollection).toHaveBeenCalledWith('persisted-runtime-actions')
		expect(collection.findOne({ id: 'a' })).toEqual({ id: 'a', value: 1 })
	})
})
