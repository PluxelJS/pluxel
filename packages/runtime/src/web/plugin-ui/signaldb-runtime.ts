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
import type { DependencyList } from 'react'
import { useMemo } from 'react'
import type { RuntimeTransportClient } from '../client'
import type { SseMessage } from '../sse'
import {
	type SignalDbFindOptions,
	type SignalDbItem,
	type SignalDbModifier,
	type SignalDbSelector,
	type SignalDbSyncEvent,
	signalDbNamespace,
} from './signaldb-contracts'

type CollectionMeta = {
	ready: WriteSignal<boolean>
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
	private readonly namespace: string
	private readonly sse
	private readonly bucket
	private readonly stopBucketSubscription: () => void
	private readonly stopOpenSubscription: () => void
	private readonly sync: SyncManager<SyncCollectionOptions, SignalDbItem, string>
	private readonly states = new Map<string, CollectionState<SignalDbItem>>()
	private readonly remoteHandlers = new Map<
		string,
		Set<(data?: LoadResponse<SignalDbItem>) => Promise<void>>
	>()
	private readonly syncTasks = new Map<string, Promise<void>>()
	private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

	constructor(
		private readonly pluginName: string,
		private readonly transport: RuntimeTransportClient,
	) {
		this.namespace = signalDbNamespace(pluginName)
		this.sse = transport.createSse({ namespaces: [this.namespace] })
		this.bucket = this.sse.ns(this.namespace)
		this.sync = new SyncManager<SyncCollectionOptions, SignalDbItem, string>({
			autostart: true,
			pull: async ({ name }: SyncCollectionOptions) => {
				const response = await this.transport.fetch(
					this.transport.links.signaldbCollection(this.pluginName, name),
					{
						method: 'GET',
					},
				)
				if (!response.ok) throw new Error(`signaldb pull failed: HTTP ${response.status}`)
				return (await response.json()) as LoadResponse<SignalDbItem>
			},
			push: async (
				{ name }: SyncCollectionOptions,
				{ changes }: { changes: Changeset<SignalDbItem> },
			) => {
				const response = await this.transport.fetch(
					this.transport.links.signaldbCollection(this.pluginName, name),
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
				onChange: (data?: LoadResponse<SignalDbItem>) => Promise<void>,
			) => {
				const handlers = this.remoteHandlers.get(name) ?? new Set()
				if (!this.remoteHandlers.has(name)) this.remoteHandlers.set(name, handlers)
				handlers.add(onChange)
				return () => {
					handlers.delete(onChange)
					if (handlers.size === 0) this.remoteHandlers.delete(name)
				}
			},
			onError: ({ name }: SyncCollectionOptions, error: Error) => {
				console.warn(`[plugin-ui:${this.pluginName}] signaldb sync error (${name})`, error)
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
		this.syncTasks.clear()
		void this.sync.dispose().catch((): undefined => undefined)
		this.sse.close()
	}

	private ensureState(collection: string): CollectionState<SignalDbItem> {
		let state = this.states.get(collection)
		if (state) return state

		const signalCollection = new SignalCollection<SignalDbItem, string, SignalDbItem>({
			name: `${this.pluginName}:${collection}`,
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

	private async dispatchRemoteChange(collection: string, data?: LoadResponse<SignalDbItem>) {
		const handlers = this.remoteHandlers.get(collection)
		if (!handlers?.size) return
		await Promise.all(Array.from(handlers, (handler) => handler(data)))
	}

	private syncCollection(collection: string): Promise<void> {
		const pending = this.syncTasks.get(collection)
		if (pending) return pending

		const task = this.sync
			.sync(collection, { force: true })
			.then(() => {
				const state = this.states.get(collection)
				if (!state) return
				this.clearRetry(collection)
				state.meta.ready.set(true)
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
		const state = this.states.get(payload.collection)
		if (!state) return
		const data = toLoadResponse(payload)
		if (!data) return

		await this.dispatchRemoteChange(payload.collection, data)
		const current = this.states.get(payload.collection)
		if (!current) return
		this.clearRetry(payload.collection)
		current.meta.ready.set(true)
		current.meta.version.set(payload.version)
	}
}

class SignalDbReplicaRoot {
	private readonly namespaces = new Map<string, SignalDbReplicaNamespace>()

	constructor(private readonly transport: RuntimeTransportClient) {}

	namespace(pluginName: string): SignalDbReplicaNamespace {
		let replica = this.namespaces.get(pluginName)
		if (!replica) {
			replica = new SignalDbReplicaNamespace(pluginName, this.transport)
			this.namespaces.set(pluginName, replica)
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
	// Force React to subscribe to collection writes even when callers only use
	// `find()` / `findOne()` / `count()` during render and ignore `items`.
	void state.meta.revision()

	return {
		name,
		ready: state.meta.ready(),
		version: state.meta.version(),
		items: state.collection.find().fetch().map(cloneItem),
		find(selector = {} as SignalDbSelector<T>, options) {
			return state.collection
				.find(selector as any, options as any)
				.fetch()
				.map(cloneItem)
		},
		findOne(selector) {
			const item = state.collection.findOne(selector as any)
			return item ? cloneItem(item) : undefined
		},
		count(selector = {} as SignalDbSelector<T>) {
			return state.collection.find(selector as any).count()
		},
		insert(item) {
			return state.collection.insert(cloneItem(item))
		},
		insertMany(items) {
			return state.collection.insertMany(items.map(cloneItem))
		},
		updateOne(selector, modifier, options) {
			return state.collection.updateOne(selector as any, cloneItem(modifier) as any, options)
		},
		replaceOne(selector, replacement, options) {
			return state.collection.replaceOne(selector as any, cloneItem(replacement), options)
		},
		removeOne(selector) {
			return state.collection.removeOne(selector as any)
		},
		removeMany(selector) {
			return state.collection.removeMany(selector as any)
		},
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
	pluginName: string,
	collection: string,
): SignalDbCollectionView<T> {
	const namespace = useMemo(
		() => getReplicaRoot(transport).namespace(pluginName),
		[pluginName, transport],
	)
	return useSignalDbReactive(() => namespace.getView<T>(collection), [collection, namespace])
}

export function useSignalDbCollectionsState(
	transport: RuntimeTransportClient,
	pluginName: string,
	collections: string[],
): Record<string, SignalDbCollectionView<SignalDbItem>> {
	const namespace = useMemo(
		() => getReplicaRoot(transport).namespace(pluginName),
		[pluginName, transport],
	)
	const collectionsKey = collections.join('\0')

	return useSignalDbReactive(
		() =>
			Object.fromEntries(
				collections.map((collection) => [collection, namespace.getView(collection)]),
			),
		[collectionsKey, namespace],
	)
}

export function useSignalDbDocState<T extends SignalDbItem>(
	transport: RuntimeTransportClient,
	pluginName: string,
	collection: string,
	selector: SignalDbSelector<T>,
): T | undefined {
	const namespace = useMemo(
		() => getReplicaRoot(transport).namespace(pluginName),
		[pluginName, transport],
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
