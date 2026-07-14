import { effect, signal, type WriteSignal } from '@maverick-js/signals'
import {
	Collection as SignalCollection,
	type Changeset,
	type Collection,
	type LoadResponse,
} from '@signaldb/core'
import maverickjsReactivityAdapter from '@signaldb/maverickjs'
import { createUseReactivityHook } from '@signaldb/react'
import { SyncManager } from '@signaldb/sync'
import { useEffect, useMemo, type DependencyList } from 'react'
import type { RuntimeTransportClient } from '../web/client'
import { registerRuntimeTransportCleanup } from '../web/client-lifecycle'
import type { SseClientWithNamespaces, SseMessage } from '../web/sse'
import {
	type SignalDbFindOptions,
	type SignalDbItem,
	type SignalDbLoadResponse,
	type SignalDbModifier,
	type SignalDbSelector,
	type SignalDbSyncEvent,
} from './collection-contracts'

type CollectionMeta = {
	ready: WriteSignal<boolean>
	clientWrites: WriteSignal<boolean | null>
	version: WriteSignal<number>
	revision: WriteSignal<number>
}

type CollectionState<T extends SignalDbItem> = {
	collection: Collection<T, string, T>
	meta: CollectionMeta
	stopObserve: () => void
}

type SyncCollectionOptions = {
	name: string
}

const useSignalDbReactive = createUseReactivityHook(effect)
const SIGNALDB_SYNC_RETRY_MS = 800
const SIGNALDB_REPLICA_IDLE_TTL_MS = 5_000

type CollectionStreamListener = {
	onMessage(message: SseMessage<string>): void
}

class WorkbenchBindingExpiredError extends Error {
	constructor(binding: string) {
		super(`[workbench-collection] binding expired: ${binding}`)
	}
}

class CollectionStreamPool {
	private readonly listeners = new Map<string, Set<CollectionStreamListener>>()
	private current:
		| {
				signature: string
				sse: SseClientWithNamespaces
				stopAny: () => void
				stopOpen: () => void
				stopError: () => void
		  }
		| undefined
	private refreshTimer: ReturnType<typeof setTimeout> | undefined
	private streamErrorReported = false
	private disposed = false

	constructor(private readonly transport: RuntimeTransportClient) {}

	subscribe(binding: string, listener: CollectionStreamListener): () => void {
		if (this.disposed) throw new Error('[workbench-collection] stream pool is disposed')
		let listeners = this.listeners.get(binding)
		const bindingAdded = !listeners
		if (!listeners) {
			listeners = new Set()
			this.listeners.set(binding, listeners)
		}
		listeners.add(listener)
		if (bindingAdded) this.scheduleRefresh()

		let active = true
		return () => {
			if (!active) return
			active = false
			const current = this.listeners.get(binding)
			if (!current) return
			current.delete(listener)
			if (current.size > 0) return
			this.listeners.delete(binding)
			this.scheduleRefresh()
		}
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		if (this.refreshTimer) clearTimeout(this.refreshTimer)
		this.refreshTimer = undefined
		this.closeCurrent()
		this.listeners.clear()
	}

	private scheduleRefresh() {
		if (this.disposed || this.refreshTimer) return
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined
			this.refresh()
		}, 0)
	}

	private refresh() {
		if (this.disposed) return
		const bindings = [...this.listeners.keys()].sort()
		const signature = bindings.join('\u0000')
		if (this.current?.signature === signature) return
		this.closeCurrent()
		if (bindings.length === 0) return

		const sse = this.transport.createSse({
			url: this.transport.links.workbenchCollectionEvents(bindings),
		})
		const stopAny = sse.onAny((message) => {
			const listeners = this.listeners.get(message.namespace)
			if (!listeners) return
			for (const listener of listeners) listener.onMessage(message)
		})
		const stopOpen = sse.onOpen(() => {
			this.streamErrorReported = false
		})
		const stopError = sse.onError(() => {
			if (this.streamErrorReported || this.disposed) return
			this.streamErrorReported = true
			console.warn(
				`[workbench-collection] shared stream disconnected (${bindings.length} bindings); reconnecting`,
			)
		})
		this.current = { signature, sse, stopAny, stopOpen, stopError }
	}

	private closeCurrent() {
		const current = this.current
		if (!current) return
		this.current = undefined
		current.stopError()
		current.stopOpen()
		current.stopAny()
		current.sse.close()
	}
}

export interface SignalDbCollectionView<T extends SignalDbItem> {
	readonly name: string
	readonly ready: boolean
	readonly clientWrites: boolean
	readonly version: number
	readonly items: readonly T[]
	find(selector?: SignalDbSelector<T>, options?: SignalDbFindOptions<T>): T[]
	findOne(selector: SignalDbSelector<T>): T | undefined
	count(selector?: SignalDbSelector<T>): number
	insert(item: T): string
	insertMany(items: T[]): string[]
	updateOne(
		selector: SignalDbSelector<T>,
		modifier: SignalDbModifier<T>,
		options?: { upsert?: boolean },
	): 0 | 1
	replaceOne(selector: SignalDbSelector<T>, replacement: T, options?: { upsert?: boolean }): 0 | 1
	removeOne(selector: SignalDbSelector<T>): 0 | 1
	removeMany(selector: SignalDbSelector<T>): number
}

class SignalDbReplicaNamespace {
	private stopStreamSubscription: (() => void) | null = null
	private readonly sync: SyncManager<SyncCollectionOptions, SignalDbItem, string>
	private readonly states = new Map<string, CollectionState<SignalDbItem>>()
	private readonly remoteHandlers = new Set<
		(data?: SignalDbLoadResponse<SignalDbItem>) => Promise<void>
	>()
	private readonly queuedRemoteChanges: SignalDbLoadResponse<SignalDbItem>[] = []
	private readonly remoteTasks = new Set<Promise<void>>()
	private readonly startTasks = new Map<string, Promise<void>>()
	private readonly syncTasks = new Map<string, Promise<void>>()
	private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
	private readonly reportedSyncErrors = new Set<string>()
	private disposed = false
	private disposeTask: Promise<void> | null = null
	private logicalCollection: string | null = null
	private active = false
	private bindingExpired = false

	constructor(
		private readonly binding: string,
		private readonly transport: RuntimeTransportClient,
		private readonly streamPool: CollectionStreamPool,
	) {
		this.sync = new SyncManager<SyncCollectionOptions, SignalDbItem, string>({
			autostart: false,
			pull: async ({ name }: SyncCollectionOptions) => {
				const response = await this.transport.fetch(
					this.transport.links.workbenchCollection(this.binding),
					{
						method: 'GET',
					},
				)
				if (response.status === 410) throw new WorkbenchBindingExpiredError(this.binding)
				if (!response.ok) throw new Error(`signaldb pull failed: HTTP ${response.status}`)
				const data = (await response.json()) as SignalDbLoadResponse<SignalDbItem>
				this.applyResponseMeta(name, data)
				return data
			},
			push: async (
				{ name }: SyncCollectionOptions,
				{ changes }: { changes: Changeset<SignalDbItem> },
			) => {
				if (!hasSignalDbChanges(changes)) return
				const state = this.states.get(name)
				// SyncManager also observes mutations produced while applying a server snapshot.
				// Read-only collections must not echo that hydration back to the server. Public
				// mutation methods still reject writes in assertClientWritesEnabled().
				if (state?.meta.clientWrites() !== true) return
				const response = await this.transport.fetch(
					this.transport.links.workbenchCollection(this.binding),
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ changes }),
					},
				)
				if (response.status === 410) throw new WorkbenchBindingExpiredError(this.binding)
				if (!response.ok) throw new Error(`signaldb push failed: HTTP ${response.status}`)
			},
			registerRemoteChange: async (
				{ name }: SyncCollectionOptions,
				onChange: (data?: SignalDbLoadResponse<SignalDbItem>) => Promise<void>,
			) => {
				this.assertLogicalCollection(name)
				this.remoteHandlers.add(onChange)
				this.flushQueuedRemoteChanges(name, onChange)
				return () => {
					this.remoteHandlers.delete(onChange)
				}
			},
			onError: ({ name }: SyncCollectionOptions, error: Error) => {
				this.reportSyncError(name, error)
			},
		})
	}

	setActive(active: boolean): void {
		if (this.disposed || this.active === active) return
		this.active = active
		if (!active) {
			for (const timer of this.retryTimers.values()) clearTimeout(timer)
			this.retryTimers.clear()
			return
		}
		if (this.bindingExpired) return
		this.ensureStreamSubscription()
		for (const collection of this.states.keys()) this.requestSync(collection)
	}

	getView<T extends SignalDbItem>(collection: string): SignalDbCollectionView<T> {
		const state = this.ensureState(collection) as CollectionState<T>
		if (!state.meta.ready() && !this.syncTasks.has(collection)) {
			this.requestSync(collection)
		}
		dependOnCollectionState(state)
		return buildCollectionView(collection, state)
	}

	dispose(): Promise<void> {
		if (this.disposeTask) return this.disposeTask
		this.disposed = true
		this.disposeTask = this.disposeInternal()
		return this.disposeTask
	}

	private async disposeInternal(): Promise<void> {
		this.stopStreamSubscription?.()
		this.stopStreamSubscription = null
		for (const timer of this.retryTimers.values()) clearTimeout(timer)
		this.retryTimers.clear()

		await Promise.allSettled(this.startTasks.values())
		try {
			await this.sync.pauseAll()
		} catch (error) {
			console.warn(`[workbench-collection] failed to pause sync (${this.binding})`, error)
		}
		await Promise.allSettled([...this.remoteTasks, ...this.syncTasks.values()])

		const states = [...this.states.values()]
		for (const state of states) state.stopObserve()
		const collectionResults = await Promise.allSettled(
			states.map((state) => state.collection.dispose()),
		)
		for (const result of collectionResults) {
			if (result.status === 'rejected') {
				console.warn(
					`[workbench-collection] local collection cleanup failed (${this.binding})`,
					result.reason,
				)
			}
		}

		await this.sync.dispose()
		this.remoteHandlers.clear()
		this.queuedRemoteChanges.length = 0
		this.remoteTasks.clear()
		this.startTasks.clear()
		this.syncTasks.clear()
		this.states.clear()
		this.reportedSyncErrors.clear()
		this.logicalCollection = null
	}

	private ensureState(collection: string): CollectionState<SignalDbItem> {
		this.assertLogicalCollection(collection)
		let state = this.states.get(collection)
		if (state) return state

		const signalCollection = new SignalCollection<SignalDbItem, string, SignalDbItem>({
			name: `${this.binding}:${collection}`,
			reactivity: maverickjsReactivityAdapter,
		})
		const stopObserve = observeCollection(signalCollection, () => {
			const current = this.states.get(collection)
			if (!current) return
			current.meta.revision.set(current.meta.revision() + 1)
		})

		state = {
			collection: signalCollection,
			meta: {
				ready: signal(false),
				clientWrites: signal<boolean | null>(null),
				version: signal(0),
				revision: signal(0),
			},
			stopObserve,
		}
		this.states.set(collection, state)
		this.sync.addCollection(signalCollection, { name: collection })
		const startTask = this.sync
			.startSync(collection)
			.catch((error) => {
				this.reportSyncError(collection, error)
			})
			.finally(() => {
				this.startTasks.delete(collection)
			})
		this.startTasks.set(collection, startTask)
		this.requestSync(collection)
		return state
	}

	private assertLogicalCollection(collection: string) {
		if (this.logicalCollection === null) {
			this.logicalCollection = collection
			return
		}
		if (this.logicalCollection !== collection) {
			throw new Error(
				`[workbench-collection] opaque grant ${this.binding} was reused for both "${this.logicalCollection}" and "${collection}"`,
			)
		}
	}

	private ensureStreamSubscription() {
		if (this.stopStreamSubscription || this.disposed) return
		this.stopStreamSubscription = this.streamPool.subscribe(this.binding, {
			onMessage: (message) => {
				if (this.disposed) return
				this.trackRemoteTask(this.apply(message.payload as SignalDbSyncEvent), 'remote change')
			},
		})
	}

	private trackRemoteTask(task: Promise<void>, operation: string) {
		let tracked: Promise<void>
		tracked = task
			.catch((error) => {
				console.error(`[workbench-collection] ${operation} failed (${this.binding})`, error)
			})
			.finally(() => {
				this.remoteTasks.delete(tracked)
			})
		this.remoteTasks.add(tracked)
	}

	private requestSync(collection: string) {
		if (this.disposed || !this.active || this.bindingExpired) return
		void this.syncCollection(collection).catch((error) => {
			this.reportSyncError(collection, error)
		})
	}

	private reportSyncError(collection: string, error: unknown) {
		if (error instanceof WorkbenchBindingExpiredError) return
		if (this.reportedSyncErrors.has(collection)) return
		this.reportedSyncErrors.add(collection)
		console.error(
			`[workbench-collection] sync failed (${this.binding}:${collection}); retrying`,
			error,
		)
	}

	private scheduleRetry(collection: string) {
		if (this.disposed || !this.active || this.bindingExpired) return
		if (this.retryTimers.has(collection)) return
		const timer = setTimeout(() => {
			this.retryTimers.delete(collection)
			const state = this.states.get(collection)
			if (!state || state.meta.ready()) return
			this.requestSync(collection)
		}, SIGNALDB_SYNC_RETRY_MS)
		this.retryTimers.set(collection, timer)
	}

	private clearRetry(collection: string) {
		const timer = this.retryTimers.get(collection)
		if (!timer) return
		clearTimeout(timer)
		this.retryTimers.delete(collection)
	}

	private async dispatchRemoteChange(
		collection: string,
		data?: SignalDbLoadResponse<SignalDbItem>,
	) {
		this.applyResponseMeta(collection, data)
		if (this.remoteHandlers.size === 0) {
			if (data) this.queueRemoteChange(data)
			return
		}
		await Promise.all(Array.from(this.remoteHandlers, (handler) => handler(data)))
	}

	private queueRemoteChange(data: SignalDbLoadResponse<SignalDbItem>) {
		this.queuedRemoteChanges.push(data)
	}

	private flushQueuedRemoteChanges(
		collection: string,
		handler: (data?: SignalDbLoadResponse<SignalDbItem>) => Promise<void>,
	) {
		if (this.queuedRemoteChanges.length === 0) return
		const queued = this.queuedRemoteChanges.splice(0)
		this.trackRemoteTask(
			queued.reduce(
				(chain, data) => chain.then(() => handler(data)),
				Promise.resolve() as Promise<void>,
			),
			`queued remote change (${collection})`,
		)
	}

	private applyResponseMeta(collection: string, data?: SignalDbLoadResponse<SignalDbItem>) {
		const state = this.states.get(collection)
		const clientWrites = data?.meta?.clientWrites
		if (!state || typeof clientWrites !== 'boolean') return
		state.meta.clientWrites.set(clientWrites)
	}

	private syncCollection(collection: string): Promise<void> {
		const pending = this.syncTasks.get(collection)
		if (pending) return pending

		const task = this.sync
			.sync(collection, { force: true })
			.then((): undefined => {
				const state = this.states.get(collection)
				if (!state) return undefined
				this.reportedSyncErrors.delete(collection)
				this.clearRetry(collection)
				state.meta.ready.set(true)
				return undefined
			})
			.catch((error) => {
				if (error instanceof WorkbenchBindingExpiredError) {
					this.bindingExpired = true
					this.clearRetry(collection)
					return undefined
				}
				const state = this.states.get(collection)
				if (state) state.meta.ready.set(false)
				this.scheduleRetry(collection)
				throw error
			})
			.finally(() => {
				this.syncTasks.delete(collection)
			})
		this.syncTasks.set(collection, task)
		return task
	}

	private async apply(payload: SignalDbSyncEvent) {
		if (!payload || typeof payload !== 'object') return
		const data = toLoadResponse(payload)
		if (!data) return
		const localCollection = this.logicalCollection
		if (localCollection === null) {
			this.queueRemoteChange(data)
			return
		}
		const state = this.states.get(localCollection)
		if (!state) {
			this.queueRemoteChange(data)
			return
		}

		await this.dispatchRemoteChange(localCollection, data)
		const current = this.states.get(localCollection)
		if (!current) return
		this.clearRetry(localCollection)
		this.reportedSyncErrors.delete(localCollection)
		current.meta.ready.set(true)
		current.meta.version.set(payload.version)
	}
}

class SignalDbReplicaRoot {
	private readonly streamPool: CollectionStreamPool
	private readonly namespaces = new Map<
		string,
		{
			replica: SignalDbReplicaNamespace
			refs: number
			disposeTimer: ReturnType<typeof setTimeout> | null
		}
	>()

	constructor(private readonly transport: RuntimeTransportClient) {
		this.streamPool = new CollectionStreamPool(transport)
	}

	namespace(binding: string): SignalDbReplicaNamespace {
		let entry = this.namespaces.get(binding)
		if (!entry) {
			entry = {
				replica: new SignalDbReplicaNamespace(binding, this.transport, this.streamPool),
				refs: 0,
				disposeTimer: null,
			}
			this.namespaces.set(binding, entry)
		}
		return entry.replica
	}

	acquire(binding: string, replica: SignalDbReplicaNamespace): () => void {
		const entry = this.namespaces.get(binding)
		if (!entry || entry.replica !== replica) {
			throw new Error(`[workbench-collection] cannot acquire stale binding: ${binding}`)
		}
		if (entry.disposeTimer) {
			clearTimeout(entry.disposeTimer)
			entry.disposeTimer = null
		}
		if (entry.refs === 0) entry.replica.setActive(true)
		entry.refs += 1
		let released = false
		return () => {
			if (released) return
			released = true
			entry.refs = Math.max(0, entry.refs - 1)
			if (entry.refs > 0) return
			entry.replica.setActive(false)
			if (entry.disposeTimer) return
			// Keep recently visited views warm so route switches can reuse both their
			// local replica and the multiplex subscription. The bounded idle TTL avoids
			// retaining grants from an expired resource-graph revision for the transport lifetime.
			entry.disposeTimer = setTimeout(() => {
				entry.disposeTimer = null
				if (entry.refs > 0 || this.namespaces.get(binding) !== entry) return
				this.namespaces.delete(binding)
				void entry.replica.dispose().catch((error) => {
					console.warn(`[workbench-collection] namespace cleanup failed (${binding})`, error)
				})
			}, SIGNALDB_REPLICA_IDLE_TTL_MS)
		}
	}

	async dispose(): Promise<void> {
		const tasks: Promise<void>[] = []
		for (const [binding, entry] of this.namespaces) {
			if (entry.disposeTimer) clearTimeout(entry.disposeTimer)
			tasks.push(
				entry.replica.dispose().catch((error) => {
					console.warn(`[workbench-collection] namespace cleanup failed (${binding})`, error)
				}),
			)
		}
		this.namespaces.clear()
		this.streamPool.dispose()
		await Promise.all(tasks)
	}
}

const roots = new WeakMap<RuntimeTransportClient, SignalDbReplicaRoot>()

function getReplicaRoot(transport: RuntimeTransportClient): SignalDbReplicaRoot {
	let root = roots.get(transport)
	if (!root) {
		root = new SignalDbReplicaRoot(transport)
		roots.set(transport, root)
		const registeredRoot = root
		registerRuntimeTransportCleanup(transport, async () => {
			if (roots.get(transport) !== registeredRoot) return
			roots.delete(transport)
			await registeredRoot.dispose()
		})
	}
	return root
}

function buildCollectionView<T extends SignalDbItem>(
	name: string,
	state: CollectionState<T>,
): SignalDbCollectionView<T> {
	return {
		name,
		get ready() {
			return state.meta.ready()
		},
		get clientWrites() {
			return state.meta.clientWrites() === true
		},
		get version() {
			return state.meta.version()
		},
		get items() {
			return fetchSignalDbItems(state)
		},
		find(selector = {} as SignalDbSelector<T>, options) {
			return fetchSignalDbItems(state, selector, options)
		},
		findOne(selector) {
			const item = fetchSignalDbItems(state, selector, { limit: 1 })[0]
			return item
		},
		count(selector = {} as SignalDbSelector<T>) {
			return countSignalDbItems(state, selector)
		},
		insert(item) {
			assertClientWritesEnabled(name, state)
			return state.collection.insert(cloneItem(item))
		},
		insertMany(items) {
			assertClientWritesEnabled(name, state)
			return state.collection.insertMany(items.map(cloneItem))
		},
		updateOne(selector, modifier, options) {
			assertClientWritesEnabled(name, state)
			return state.collection.updateOne(selector as any, cloneItem(modifier) as any, options)
		},
		replaceOne(selector, replacement, options) {
			assertClientWritesEnabled(name, state)
			return state.collection.replaceOne(selector as any, cloneItem(replacement), options)
		},
		removeOne(selector) {
			assertClientWritesEnabled(name, state)
			return state.collection.removeOne(selector as any)
		},
		removeMany(selector) {
			assertClientWritesEnabled(name, state)
			return state.collection.removeMany(selector as any)
		},
	}
}

function assertClientWritesEnabled<T extends SignalDbItem>(
	name: string,
	state: CollectionState<T>,
) {
	if (state.meta.clientWrites() === true) return
	throw new Error(`signaldb collection "${name}" does not allow client writes`)
}

function dependOnCollectionState<T extends SignalDbItem>(state: CollectionState<T>) {
	void state.meta.ready()
	void state.meta.clientWrites()
	void state.meta.version()
	void state.meta.revision()
}

function hasSignalDbChanges<T extends SignalDbItem>(changes: Changeset<T>): boolean {
	return changes.added.length > 0 || changes.modified.length > 0 || changes.removed.length > 0
}

function fetchSignalDbItems<T extends SignalDbItem>(
	state: CollectionState<T>,
	selector = {} as SignalDbSelector<T>,
	options?: SignalDbFindOptions<T>,
): T[] {
	dependOnCollectionState(state)
	const cursor = state.collection.find(selector as any, options as any)
	try {
		return cursor.fetch().map(cloneItem)
	} finally {
		cursor.cleanup()
	}
}

function countSignalDbItems<T extends SignalDbItem>(
	state: CollectionState<T>,
	selector = {} as SignalDbSelector<T>,
): number {
	dependOnCollectionState(state)
	const cursor = state.collection.find(selector as any)
	try {
		return cursor.count()
	} finally {
		cursor.cleanup()
	}
}

function observeCollection<T extends SignalDbItem>(
	collection: Collection<T, string, T>,
	onChange: () => void,
): () => void {
	const cursor = collection.find()
	const stop = cursor.observeChanges(
		{
			added: onChange,
			addedBefore: onChange,
			changed: onChange,
			changedField: onChange,
			movedBefore: onChange,
			removed: onChange,
		},
		true,
	)

	return () => {
		stop()
		cursor.cleanup()
	}
}

function toLoadResponse<T extends SignalDbItem>(
	payload: SignalDbSyncEvent<T>,
): LoadResponse<T> | undefined {
	switch (payload.type) {
		case 'snapshot':
		case 'reset':
			return { items: payload.items.map(cloneItem) }
		case 'insert':
			return {
				changes: {
					added: payload.items.map(cloneItem),
					modified: [],
					removed: [],
				},
			}
		case 'update':
			return {
				changes: {
					added: [],
					modified: payload.items.map(cloneItem),
					removed: [],
				},
			}
		case 'remove':
			return {
				changes: {
					added: [],
					modified: [],
					removed: payload.ids.map((id) => ({ id }) as T),
				},
			}
		default:
			return undefined
	}
}

export function useSignalDbCollectionState<T extends SignalDbItem>(
	transport: RuntimeTransportClient,
	binding: string,
	collection: string,
): SignalDbCollectionView<T> {
	const root = useMemo(() => getReplicaRoot(transport), [transport])
	const namespace = useMemo(() => root.namespace(binding), [binding, root])
	useEffect(() => root.acquire(binding, namespace), [binding, namespace, root])
	return useSignalDbReactive(() => namespace.getView<T>(collection), [collection, namespace])
}

export function useBoundSignalDbCollectionsState(
	transport: RuntimeTransportClient,
	bindings: Readonly<Record<string, string>>,
): Record<string, SignalDbCollectionView<SignalDbItem>> {
	const bindingsKey = Object.entries(bindings)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([resource, binding]) => `${resource}\u0000${binding}`)
		.join('\u0001')
	const resources = useMemo(
		() =>
			Object.entries(bindings)
				.filter((entry): entry is [string, string] => Boolean(entry[0]) && Boolean(entry[1]))
				.map(
					([resource, binding]) =>
						[resource, binding, getReplicaRoot(transport).namespace(binding)] as const,
				),
		[bindingsKey, transport],
	)
	useEffect(() => {
		const root = getReplicaRoot(transport)
		const releases = resources.map(([, binding, namespace]) => root.acquire(binding, namespace))
		return () => {
			for (const release of releases) release()
		}
	}, [resources, transport])

	return useSignalDbReactive(
		() =>
			Object.fromEntries(
				resources.map(([resource, , namespace]) => [resource, namespace.getView(resource)]),
			),
		[bindingsKey, resources],
	)
}

export function useSignalDbQueryState<T>(query: () => T, deps: DependencyList = []): T {
	return useSignalDbReactive(query, deps)
}

function cloneItem<T>(item: T): T {
	return item && typeof item === 'object' ? ({ ...(item as Record<string, unknown>) } as T) : item
}
