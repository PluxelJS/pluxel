import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeContext } from '@pluxel/runtime/test'
import { SignalDbService } from '../../src/services/plugin-interaction/SignalDbService'

const runtimeContexts = new Set<ReturnType<typeof createRuntimeContext>>()

afterEach(async () => {
	const pending = [...runtimeContexts]
	runtimeContexts.clear()
	await Promise.all(pending.map((runtime) => runtime.dispose()))
})

function createSignalDbTestContext() {
	const runtime = createRuntimeContext()
	runtimeContexts.add(runtime)
	const sseDispose = vi.fn(() => {})
	const sseRegister = vi.fn(() => sseDispose)
	const deferred: Array<() => void> = []
	const ctx: any = runtime.ctx
	const effects = ctx.effects
	defineTestProperty(ctx, '__deferred', deferred)
	defineTestProperty(ctx, 'pluginInfo', { id: 'test-plugin' })
	defineTestProperty(ctx, 'effects', {
		defer: (fn: () => void) => {
			deferred.push(fn)
			return { dispose: fn }
		},
		dispose: () => effects.dispose(),
	})
	defineTestProperty(ctx, 'ext', {
		sse: {
			expose: sseRegister,
		},
	})
	defineTestProperty(ctx, 'pluginData', {
		persistenceForCollection: vi.fn(async () => ({
			load: async () => ({ items: [] }),
			save: async () => {},
			register: async () => {},
			unregister: async () => {},
		})),
	})
	return ctx
}

function defineTestProperty(target: object, key: string, value: unknown) {
	Object.defineProperty(target, key, {
		value,
		writable: true,
		configurable: true,
		enumerable: true,
	})
}

describe('SignalDbService', () => {
	it('collection.watch() receives client and server-side mutations', async () => {
		const ctx = createSignalDbTestContext()
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
		const ctx = createSignalDbTestContext()
		const service = new SignalDbService(ctx)
		const collection = service.collection<{ id: string; value: number }>({
			name: 'persisted-runtime-actions',
		})

		await collection.ready()
		collection.insert({ id: 'a', value: 1 })

		expect(ctx.pluginData.persistenceForCollection).toHaveBeenCalledWith(
			'persisted-runtime-actions',
		)
		expect(collection.findOne({ id: 'a' })).toEqual({ id: 'a', value: 1 })
	})

	it('provides selector-bound doc helpers for builtin sync/form/action', async () => {
		const ctx = createSignalDbTestContext()
		const service = new SignalDbService(ctx)
		const collection = service.collection<{ id: string; paused: boolean; ticks: number }>({
			name: 'runtime',
			persistence: false,
		})
		await collection.ready()
		collection.insert({ id: 'runtime', paused: false, ticks: 1 })

		const doc = collection.doc({ id: 'runtime' })
		const form = doc.form({
			schemaKey: 'runtime',
			write: collection.insertSpec({
				id: { kind: 'generatedId' },
				paused: { kind: 'field', key: 'paused' },
			}),
		})
		const action = doc.action({
			label: 'Reset',
			write: doc.patchSpec({ ticks: 0 }),
		})

		expect(doc.get()).toEqual({ id: 'runtime', paused: false, ticks: 1 })
		expect(doc.field('paused', true)).toMatchObject({
			kind: 'signaldb',
			collection: 'runtime',
			selector: { id: 'runtime' },
			path: 'paused',
			fallback: true,
		})
		expect(form).toMatchObject({
			kind: 'form',
			syncFrom: {
				kind: 'signaldb',
				collection: 'runtime',
				selector: { id: 'runtime' },
				fallback: {},
			},
			write: {
				collection: 'runtime',
				mode: 'insert',
			},
		})
		expect(action).toMatchObject({
			kind: 'action',
			label: 'Reset',
			write: {
				collection: 'runtime',
				mode: 'patch',
				selector: { id: 'runtime' },
				value: { ticks: 0 },
			},
		})
	})

	it('re-registers the signaldb SSE namespace from the sync transport path when needed', async () => {
		const ctx = createSignalDbTestContext()
		const service = new SignalDbService(ctx)
		const collection = service.collection<{ id: string; value: number }>({
			name: 'events',
			persistence: false,
		})

		await collection.ready()
		expect(ctx.ext.sse.expose).toHaveBeenCalledTimes(1)

		const streamCleanup = ctx.__deferred[0]
		expect(typeof streamCleanup).toBe('function')
		streamCleanup()

		await service.loadCollectionSync('events')

		expect(ctx.ext.sse.expose).toHaveBeenCalledTimes(2)
	})
})
