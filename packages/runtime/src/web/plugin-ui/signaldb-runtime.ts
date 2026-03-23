import {
	Collection as SignalCollection,
	type Changeset,
	type Collection,
	type LoadResponse,
} from '@signaldb/core'
import { SyncManager } from '@signaldb/sync'
import { useMemo, useSyncExternalStore } from 'react'
import type { HmrWebClient } from './ui-runtime'
import {
	type SignalDbFindOptions,
	type SignalDbItem,
	type SignalDbModifier,
	type SignalDbSelector,
	type SignalDbSyncEvent,
	signalDbNamespace,
} from './signaldb-contracts'

type CollectionMeta = {
	ready: boolean
	version: number
	revision: number
}

type CollectionState<T extends SignalDbItem> = {
	collection: Collection<T, string, T>
	meta: CollectionMeta
	stopObserve: () => void
}

type SyncCollectionOptions = {
	name: string
}

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
	replaceOne(
		selector: SignalDbSelector<T>,
		replacement: T,
		options?: { upsert?: boolean },
	): 0 | 1
	removeOne(selector: SignalDbSelector<T>): 0 | 1
	removeMany(selector: SignalDbSelector<T>): number
}

class SignalDbReplicaNamespace {
	private readonly namespace: string
	private readonly sse
	private readonly bucket
	private readonly sync: SyncManager<SyncCollectionOptions, SignalDbItem, string>
	private readonly states = new Map<string, CollectionState<SignalDbItem>>()
	private readonly listeners = new Map<string, Set<() => void>>()
	private readonly remoteHandlers = new Map<
		string,
		Set<(data?: LoadResponse<SignalDbItem>) => Promise<void>>
	>()
	private readonly syncTasks = new Map<string, Promise<void>>()

	constructor(
		private readonly pluginName: string,
		private readonly hmr: HmrWebClient,
	) {
		this.namespace = signalDbNamespace(pluginName)
		this.sse = hmr.createSse({ namespaces: [this.namespace] })
		this.bucket = this.sse.ns(this.namespace)
		this.sync = new SyncManager<SyncCollectionOptions, SignalDbItem, string>({
			autostart: true,
			pull: async ({ name }: SyncCollectionOptions) => {
				const response = await this.hmr.fetch(this.hmr.transport.signaldbCollection(this.pluginName, name), {
					method: 'GET',
				})
				if (!response.ok) throw new Error(`signaldb pull failed: HTTP ${response.status}`)
				return (await response.json()) as LoadResponse<SignalDbItem>
			},
			push: async (
				{ name }: SyncCollectionOptions,
				{ changes }: { changes: Changeset<SignalDbItem> },
			) => {
				const response = await this.hmr.fetch(this.hmr.transport.signaldbCollection(this.pluginName, name), {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ changes }),
				})
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

		this.bucket.onAny((msg) => {
			void this.apply(msg.payload as SignalDbSyncEvent)
		})
	}

	subscribe(collection: string, cb: () => void): () => void {
		this.ensureState(collection)
		const set = this.listeners.get(collection) ?? new Set<() => void>()
		if (!this.listeners.has(collection)) this.listeners.set(collection, set)
		set.add(cb)

		return () => {
			set.delete(cb)
			if (set.size === 0) this.listeners.delete(collection)
		}
	}

	getView<T extends SignalDbItem>(collection: string): SignalDbCollectionView<T> {
		const state = this.ensureState(collection) as CollectionState<T>
		return buildCollectionView(collection, state)
	}

	token(collection: string): string {
		const state = this.ensureState(collection)
		return `${state.meta.ready ? 1 : 0}:${state.meta.version}:${state.meta.revision}`
	}

	dispose() {
		for (const state of this.states.values()) state.stopObserve()
		this.states.clear()
		this.listeners.clear()
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
		})
		const stopObserve = observeCollection(signalCollection, () => {
			const current = this.states.get(collection)
			if (!current) return
			current.meta = {
				...current.meta,
				revision: current.meta.revision + 1,
			}
			this.notify(collection)
		})

		state = {
			collection: signalCollection,
			meta: { ready: false, version: 0, revision: 0 },
			stopObserve,
		}
		this.states.set(collection, state)
		this.sync.addCollection(signalCollection, { name: collection })
		void this.syncCollection(collection)
		return state
	}

	private notify(collection: string) {
		const listeners = this.listeners.get(collection)
		if (!listeners?.size) return
		for (const listener of listeners) listener()
	}

	private markMeta(collection: string, patch: Partial<CollectionMeta>) {
		const state = this.states.get(collection)
		if (!state) return
		const next = { ...state.meta, ...patch }
		if (
			next.ready === state.meta.ready &&
			next.version === state.meta.version &&
			next.revision === state.meta.revision
		) {
			return
		}
		state.meta = next
		this.notify(collection)
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
				this.markMeta(collection, { ready: true })
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
		this.markMeta(payload.collection, {
			ready: true,
			version: payload.version,
		})
	}
}

class SignalDbReplicaRoot {
	private readonly namespaces = new Map<string, SignalDbReplicaNamespace>()

	constructor(private readonly hmr: HmrWebClient) {}

	namespace(pluginName: string): SignalDbReplicaNamespace {
		let replica = this.namespaces.get(pluginName)
		if (!replica) {
			replica = new SignalDbReplicaNamespace(pluginName, this.hmr)
			this.namespaces.set(pluginName, replica)
		}
		return replica
	}

	dispose() {
		for (const namespace of this.namespaces.values()) namespace.dispose()
		this.namespaces.clear()
	}
}

const roots = new WeakMap<HmrWebClient, SignalDbReplicaRoot>()
const patchedClients = new WeakSet<HmrWebClient>()

function getReplicaRoot(hmr: HmrWebClient): SignalDbReplicaRoot {
	let root = roots.get(hmr)
	if (!root) {
		root = new SignalDbReplicaRoot(hmr)
		roots.set(hmr, root)
		if (!patchedClients.has(hmr)) {
			patchedClients.add(hmr)
			const originalDispose = hmr.dispose.bind(hmr)
			hmr.dispose = (): void => {
				const current = roots.get(hmr)
				if (current) {
					current.dispose()
					roots.delete(hmr)
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
		ready: state.meta.ready,
		version: state.meta.version,
		items: state.collection.find().fetch().map(cloneItem),
		find(selector = {} as SignalDbSelector<T>, options) {
			return state.collection.find(selector as any, options as any).fetch().map(cloneItem)
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
					removed: payload.ids.map((id) => ({ id } as T)),
				},
			}
		default:
			return undefined
	}
}

export function useSignalDbCollectionState<T extends SignalDbItem>(
	hmr: HmrWebClient,
	pluginName: string,
	collection: string,
): SignalDbCollectionView<T> {
	const namespace = useMemo(() => getReplicaRoot(hmr).namespace(pluginName), [hmr, pluginName])
	const stateToken = useSyncExternalStore(
		(cb) => namespace.subscribe(collection, cb),
		() => namespace.token(collection),
		() => '0:0:0',
	)

	return useMemo(() => namespace.getView<T>(collection), [collection, namespace, stateToken])
}

export function useSignalDbCollectionsState(
	hmr: HmrWebClient,
	pluginName: string,
	collections: string[],
): Record<string, SignalDbCollectionView<SignalDbItem>> {
	const namespace = useMemo(() => getReplicaRoot(hmr).namespace(pluginName), [hmr, pluginName])
	const token = useSyncExternalStore(
		(cb) => {
			const unsubs = collections.map((collection) => namespace.subscribe(collection, cb))
			return () => {
				for (const unsub of unsubs) unsub()
			}
		},
		() =>
			collections
				.map((collection) => {
					return `${collection}:${namespace.token(collection)}`
				})
				.join('|'),
		() => '',
	)

	return useMemo(
		() =>
			Object.fromEntries(collections.map((collection) => [collection, namespace.getView(collection)])),
		[collections, namespace, token],
	)
}

export function useSignalDbDocState<T extends SignalDbItem>(
	hmr: HmrWebClient,
	pluginName: string,
	collection: string,
	selector: SignalDbSelector<T>,
): T | undefined {
	const view = useSignalDbCollectionState<T>(hmr, pluginName, collection)
	return useMemo(() => view.findOne(selector), [selector, view])
}

function cloneItem<T>(item: T): T {
	return item && typeof item === 'object' ? ({ ...(item as Record<string, unknown>) } as T) : item
}
