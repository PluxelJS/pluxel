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
import { useMemo, type DependencyList } from 'react'
import type { RuntimeTransportClient } from '../web/client'
import type { SseMessage } from '../web/sse'
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
	private readonly sse
	private readonly bucket
	private readonly stopBucketSubscription: () => void
	private readonly stopOpenSubscription: () => void
	private readonly sync: SyncManager<SyncCollectionOptions, SignalDbItem, string>
	private readonly states = new Map<string, CollectionState<SignalDbItem>>()
	private readonly remoteHandlers = new Map<
		string,
		Set<(data?: SignalDbLoadResponse<SignalDbItem>) => Promise<void>>
	>()
	private readonly queuedRemoteChanges = new Map<string, SignalDbLoadResponse<SignalDbItem>[]>()
	private readonly syncTasks = new Map<string, Promise<void>>()
	private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

	constructor(
		private readonly binding: string,
		private readonly transport: RuntimeTransportClient,
	) {
		this.sse = transport.management.stream(binding)
		this.bucket = this.sse
		this.sync = new SyncManager<SyncCollectionOptions, SignalDbItem, string>({
			autostart: true,
			pull: async ({ name }: SyncCollectionOptions) => {
				const response = await this.transport.fetch(
					this.transport.links.managementCollection(this.binding),
					{
						method: 'GET',
					},
				)
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
				if (state?.meta.clientWrites() !== true) {
					throw new Error(`signaldb collection "${name}" does not allow client writes`)
				}
				const response = await this.transport.fetch(
					this.transport.links.managementCollection(this.binding),
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ changes }),
					},
				)
				if (!response.ok) throw new Error(`signaldb push failed: HTTP ${response.status}`)
			},
			registerRemoteChange: async (
				{ name }: SyncCollectionOptions,
				onChange: (data?: SignalDbLoadResponse<SignalDbItem>) => Promise<void>,
			) => {
				const handlers = this.remoteHandlers.get(name) ?? new Set()
				if (!this.remoteHandlers.has(name)) this.remoteHandlers.set(name, handlers)
				handlers.add(onChange)
				this.flushQueuedRemoteChanges(name, onChange)
				return () => {
					handlers.delete(onChange)
					if (handlers.size === 0) this.remoteHandlers.delete(name)
				}
			},
			onError: ({ name }: SyncCollectionOptions, error: Error) => {
				console.warn(`[management:${this.binding}] collection sync error (${name})`, error)
			},
		})

		this.stopBucketSubscription = this.bucket.onAny((msg: SseMessage<string>) => {
			void this.apply(msg.payload as SignalDbSyncEvent)
		})
		this.stopOpenSubscription = this.sse.onOpen(() => {
			for (const collection of this.states.keys()) this.requestSync(collection)
		})
	}

	getView<T extends SignalDbItem>(collection: string): SignalDbCollectionView<T> {
		const state = this.ensureState(collection) as CollectionState<T>
		if (!state.meta.ready() && !this.syncTasks.has(collection)) {
			this.requestSync(collection)
		}
		dependOnCollectionState(state)
		return buildCollectionView(collection, state)
	}

	dispose() {
		this.stopOpenSubscription()
		this.stopBucketSubscription()
		for (const timer of this.retryTimers.values()) clearTimeout(timer)
		this.retryTimers.clear()
		for (const state of this.states.values()) state.stopObserve()
		this.states.clear()
		this.remoteHandlers.clear()
		this.queuedRemoteChanges.clear()
		this.syncTasks.clear()
		void this.sync.dispose().catch((): undefined => undefined)
		this.sse.close()
	}

	private ensureState(collection: string): CollectionState<SignalDbItem> {
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
		this.requestSync(collection)
		return state
	}

	private requestSync(collection: string) {
		void this.syncCollection(collection).catch((): undefined => undefined)
	}

	private scheduleRetry(collection: string) {
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
		const handlers = this.remoteHandlers.get(collection)
		if (!handlers?.size) {
			if (data) this.queueRemoteChange(collection, data)
			return
		}
		await Promise.all(Array.from(handlers, (handler) => handler(data)))
	}

	private queueRemoteChange(collection: string, data: SignalDbLoadResponse<SignalDbItem>) {
		const queued = this.queuedRemoteChanges.get(collection) ?? []
		queued.push(data)
		this.queuedRemoteChanges.set(collection, queued)
	}

	private flushQueuedRemoteChanges(
		collection: string,
		handler: (data?: SignalDbLoadResponse<SignalDbItem>) => Promise<void>,
	) {
		const queued = this.queuedRemoteChanges.get(collection)
		if (!queued?.length) return
		this.queuedRemoteChanges.delete(collection)
		void queued
			.reduce((chain, data) => chain.then(() => handler(data)), Promise.resolve() as Promise<void>)
			.catch((error) => {
				console.warn(
					`[management:${this.binding}] queued remote change failed (${collection})`,
					error,
				)
			})
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
				this.clearRetry(collection)
				state.meta.ready.set(true)
				return undefined
			})
			.catch((error) => {
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
		const localCollection =
			this.states.size === 1 ? this.states.keys().next().value : payload.collection
		if (typeof localCollection !== 'string') return
		const state = this.states.get(localCollection)
		if (!state) {
			this.queueRemoteChange(localCollection, data)
			return
		}

		await this.dispatchRemoteChange(localCollection, data)
		const current = this.states.get(localCollection)
		if (!current) return
		this.clearRetry(localCollection)
		current.meta.ready.set(true)
		current.meta.version.set(payload.version)
	}
}

class SignalDbReplicaRoot {
	private readonly namespaces = new Map<string, SignalDbReplicaNamespace>()

	constructor(private readonly transport: RuntimeTransportClient) {}

	namespace(binding: string): SignalDbReplicaNamespace {
		let replica = this.namespaces.get(binding)
		if (!replica) {
			replica = new SignalDbReplicaNamespace(binding, this.transport)
			this.namespaces.set(binding, replica)
		}
		return replica
	}

	dispose() {
		for (const namespace of this.namespaces.values()) namespace.dispose()
		this.namespaces.clear()
	}
}

const roots = new WeakMap<RuntimeTransportClient, SignalDbReplicaRoot>()
const patchedClients = new WeakSet<RuntimeTransportClient>()

function getReplicaRoot(transport: RuntimeTransportClient): SignalDbReplicaRoot {
	let root = roots.get(transport)
	if (!root) {
		root = new SignalDbReplicaRoot(transport)
		roots.set(transport, root)
		if (!patchedClients.has(transport)) {
			patchedClients.add(transport)
			const originalDispose = transport.dispose.bind(transport)
			transport.dispose = (): void => {
				const current = roots.get(transport)
				if (current) {
					current.dispose()
					roots.delete(transport)
				}
				originalDispose()
			}
		}
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
	const namespace = useMemo(
		() => getReplicaRoot(transport).namespace(binding),
		[binding, transport],
	)
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
						[resource, getReplicaRoot(transport).namespace(binding)] as const,
				),
		[bindingsKey, transport],
	)

	return useSignalDbReactive(
		() =>
			Object.fromEntries(
				resources.map(([resource, namespace]) => [resource, namespace.getView(resource)]),
			),
		[bindingsKey, resources],
	)
}

export function useSignalDbDocState<T extends SignalDbItem>(
	transport: RuntimeTransportClient,
	binding: string,
	collection: string,
	selector: SignalDbSelector<T>,
): T | undefined {
	const namespace = useMemo(
		() => getReplicaRoot(transport).namespace(binding),
		[binding, transport],
	)
	return useSignalDbReactive(
		() => namespace.getView<T>(collection).findOne(selector),
		[collection, namespace, selector],
	)
}

export function useSignalDbQueryState<T>(query: () => T, deps: DependencyList = []): T {
	return useSignalDbReactive(query, deps)
}

function cloneItem<T>(item: T): T {
	return item && typeof item === 'object' ? ({ ...(item as Record<string, unknown>) } as T) : item
}
