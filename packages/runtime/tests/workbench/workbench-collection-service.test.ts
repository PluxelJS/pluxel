import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeContext } from '@pluxel/runtime/test'
import { requireWorkbench } from '../../src/services/workbench'
import { WorkbenchCollectionService } from '../../src/services/workbench/resources/WorkbenchCollectionService'

const runtimeContexts = new Set<ReturnType<typeof createRuntimeContext>>()

afterEach(async () => {
	const pending = [...runtimeContexts]
	runtimeContexts.clear()
	await Promise.all(pending.map((runtime) => runtime.dispose()))
})

function createCollectionTestContext() {
	const runtime = createRuntimeContext()
	runtimeContexts.add(runtime)
	const sseDispose = vi.fn(() => {})
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
	const eventsExpose = vi
		.spyOn(requireWorkbench(ctx).events, 'registerResourceFor')
		.mockImplementation(() => sseDispose)
	defineTestProperty(ctx, '__eventsExpose', eventsExpose)
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

describe('WorkbenchCollectionService', () => {
	it('collection.watch() receives client and server-side mutations', async () => {
		const ctx = createCollectionTestContext()
		const service = new WorkbenchCollectionService(ctx, undefined, requireWorkbench(ctx).events)
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

		expect(events).toEqual(['snapshot', 'insert', 'update', 'remove'])
	})

	it('replays a snapshot to late collection watchers', async () => {
		const ctx = createCollectionTestContext()
		const service = new WorkbenchCollectionService(ctx, undefined, requireWorkbench(ctx).events)
		const collection = service.collection<{ id: string; value: number }>({
			name: 'late-watch',
			persistence: false,
		})
		await collection.ready()
		collection.insert({ id: 'a', value: 1 })

		const events: unknown[] = []
		const stop = collection.watch((event) => events.push(event))
		stop()

		expect(events).toEqual([
			{
				type: 'snapshot',
				collection: 'late-watch',
				version: 1,
				items: [{ id: 'a', value: 1 }],
			},
		])
	})

	it('keeps workbench projections in memory by default', async () => {
		const ctx = createCollectionTestContext()
		const service = new WorkbenchCollectionService(ctx, undefined, requireWorkbench(ctx).events)
		const collection = service.collection<{ id: string; value: number }>({
			name: 'runtime-actions',
		})

		await collection.ready()
		collection.insert({ id: 'a', value: 1 })

		expect(ctx.pluginData.persistenceForCollection).not.toHaveBeenCalled()
		expect(collection.findOne({ id: 'a' })).toEqual({ id: 'a', value: 1 })
	})

	it('creates explicitly persisted collections without a transient adapter-less instance', async () => {
		const ctx = createCollectionTestContext()
		const service = new WorkbenchCollectionService(ctx, undefined, requireWorkbench(ctx).events)
		const collection = service.collection<{ id: string; value: number }>({
			name: 'persisted-runtime-actions',
			persistence: true,
		})

		await collection.ready()
		collection.insert({ id: 'a', value: 1 })

		expect(ctx.pluginData.persistenceForCollection).toHaveBeenCalledWith(
			'persisted-runtime-actions',
		)
		expect(collection.findOne({ id: 'a' })).toEqual({ id: 'a', value: 1 })
	})

	it('flushes explicit persistence before unregistering the adapter', async () => {
		const ctx = createCollectionTestContext()
		let finishSave: () => void = () => {}
		const unregister = vi.fn(async () => {})
		ctx.pluginData.persistenceForCollection.mockResolvedValue({
			load: async () => ({ items: [] }),
			save: vi.fn(
				async () =>
					await new Promise<void>((resolve) => {
						finishSave = resolve
					}),
			),
			register: async () => {},
			unregister,
		})
		const service = new WorkbenchCollectionService(ctx, undefined, requireWorkbench(ctx).events)
		const collection = service.collection<{ id: string; value: number }>({
			name: 'slow-persistence',
			persistence: true,
		})
		await collection.ready()
		collection.insert({ id: 'a', value: 1 })

		const disposeCollection = ctx.__deferred.at(-1)
		disposeCollection()
		await Promise.resolve()
		expect(unregister).not.toHaveBeenCalled()

		finishSave()
		await vi.waitFor(() => expect(unregister).toHaveBeenCalledOnce())
	})

	it('includes client write permissions in sync snapshots', async () => {
		const ctx = createCollectionTestContext()
		const service = new WorkbenchCollectionService(ctx, undefined, requireWorkbench(ctx).events)
		const readonlyCollection = service.collection<{ id: string; value: number }>({
			name: 'readonly-events',
			persistence: false,
		})
		const writableCollection = service.collection<{ id: string; value: number }>({
			name: 'writable-events',
			persistence: false,
			clientWrites: true,
		})

		await Promise.all([readonlyCollection.ready(), writableCollection.ready()])

		await expect(service.loadCollectionSync('readonly-events')).resolves.toMatchObject({
			meta: { clientWrites: false },
		})
		await expect(service.loadCollectionSync('writable-events')).resolves.toMatchObject({
			meta: { clientWrites: true },
		})
	})

	it('provides selector-bound doc helpers for builtin sync/form/action', async () => {
		const ctx = createCollectionTestContext()
		const service = new WorkbenchCollectionService(ctx, undefined, requireWorkbench(ctx).events)
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

	it('scopes late event snapshots to the bound collection', async () => {
		const ctx = createCollectionTestContext()
		const service = new WorkbenchCollectionService(ctx, undefined, requireWorkbench(ctx).events)
		const collection = service.collection<{ id: string; value: number }>({
			name: 'events',
			persistence: false,
		})
		const other = service.collection<{ id: string; value: number }>({
			name: 'status',
			persistence: false,
		})
		await Promise.all([collection.ready(), other.ready()])
		collection.insert({ id: 'a', value: 1 })
		other.insert({ id: 'b', value: 2 })

		expect(ctx.__eventsExpose.mock.calls.map((call: unknown[]) => call[1])).toEqual([
			'test-plugin:signaldb:events',
			'test-plugin:signaldb:status',
		])

		const handler = ctx.__eventsExpose.mock.calls[0][2]
		const channel = {
			closed: false,
			emit: vi.fn(),
			onAbort: vi.fn(),
		}

		const cleanup = handler(channel)
		await vi.waitFor(() => expect(channel.emit).toHaveBeenCalled())

		expect(channel.emit).toHaveBeenCalledWith('snapshot', {
			type: 'snapshot',
			collection: 'events',
			version: 1,
			items: [{ id: 'a', value: 1 }],
		})
		cleanup?.()
	})
})
