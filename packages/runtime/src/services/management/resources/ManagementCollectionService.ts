import { Collection as SignalCollection, type Changeset, type Collection } from '@signaldb/core'
import type { Context } from '@pluxel/core'
import type {
	BuiltinActionBlock,
	BuiltinFormBlock,
	BuiltinSignalDbWriteSpec,
	BuiltinSyncRef,
	BuiltinTemplateValue,
} from '../../../management/document-contracts'
import {
	type SignalDbFindOptions,
	type SignalDbItem,
	type SignalDbLoadResponse,
	type SignalDbModifier,
	type SignalDbSelector,
	type SignalDbSyncEvent,
	signalDbNamespace,
} from '../../../management/collection-contracts'
import type { ManagementStreamService, SseChannel } from './ManagementStreamService'

export interface SignalDbCollectionOptions<T extends SignalDbItem> {
	name: string
	/** Persist this management projection in plugin data. Defaults to false. */
	persistence?: boolean
	initial?: T[] | (() => T[])
	clientWrites?: boolean
}

export interface SignalDbDocumentHandle<TState extends SignalDbItem> {
	readonly collection: string
	readonly selector: SignalDbSelector<TState>
	get(): TState | undefined
	field<K extends keyof TState & string>(key: K, fallback: TState[K]): BuiltinSyncRef<TState[K]>
	path<TValue = unknown>(path: string, fallback: TValue): BuiltinSyncRef<TValue>
	snapshot(fallback: TState): BuiltinSyncRef<TState>
	form(input: Omit<BuiltinFormBlock, 'kind' | 'syncFrom'>): BuiltinFormBlock
	formFrom(
		syncFrom: BuiltinSyncRef<Record<string, unknown>> | TState,
		input: Omit<BuiltinFormBlock, 'kind' | 'syncFrom'>,
	): BuiltinFormBlock
	formUnsynced(input: Omit<BuiltinFormBlock, 'kind' | 'syncFrom'>): BuiltinFormBlock
	action(input: Omit<BuiltinActionBlock, 'kind'>): BuiltinActionBlock
	patchSpec(value: BuiltinTemplateValue, options?: { upsert?: boolean }): BuiltinSignalDbWriteSpec
	replaceSpec(value: BuiltinTemplateValue, options?: { upsert?: boolean }): BuiltinSignalDbWriteSpec
	removeSpec(): BuiltinSignalDbWriteSpec
}

export interface SignalDbCollectionHandle<T extends SignalDbItem> {
	readonly name: string
	ready(): Promise<void>
	watch(listener: (event: SignalDbSyncEvent<T>) => void): () => void
	/** Selector-bound document view for builtin refs/forms/actions. */
	doc(selector: SignalDbSelector<T>): SignalDbDocumentHandle<T>
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
	reset(items: T[]): void
	insertSpec(value: BuiltinTemplateValue): BuiltinSignalDbWriteSpec
	patchSpec(
		selector: SignalDbSelector<T>,
		value: BuiltinTemplateValue,
		options?: { upsert?: boolean },
	): BuiltinSignalDbWriteSpec
	replaceSpec(
		selector: SignalDbSelector<T>,
		value: BuiltinTemplateValue,
		options?: { upsert?: boolean },
	): BuiltinSignalDbWriteSpec
	removeSpec(selector: SignalDbSelector<T>): BuiltinSignalDbWriteSpec
}

export class ManagementCollectionService {
	private readonly collectionsByPlugin = new Map<
		string,
		Map<string, ManagedSignalDbCollection<any>>
	>()
	private readonly channelsByCollection = new Map<string, Set<SseChannel>>()
	private readonly streamDisposers = new Map<string, () => void>()
	private readonly ownersByPlugin = new Map<string, Context>()

	constructor(
		public ctx: Context,
		_cfg: unknown,
		private readonly streams: Pick<ManagementStreamService, 'registerResourceFor'>,
	) {}

	collection<T extends SignalDbItem>(
		options: SignalDbCollectionOptions<T>,
	): SignalDbCollectionHandle<T> {
		return this.collectionFor(this.ctx, options)
	}

	/** @internal Register against an immutable owner Context. */
	collectionFor<T extends SignalDbItem>(
		owner: Context,
		options: SignalDbCollectionOptions<T>,
	): SignalDbCollectionHandle<T> {
		const pluginName = String(owner.pluginInfo.id ?? '').trim()
		const name = String(options.name ?? '').trim()
		if (!name) throw new Error('[management] collection(): name required')

		const collections = this.collectionsFor(pluginName)
		this.ownersByPlugin.set(pluginName, owner)
		const existing = collections.get(name)
		if (existing) return existing.publicApi as SignalDbCollectionHandle<T>

		const managed = new ManagedSignalDbCollection<T>(owner, this, {
			...options,
			name,
			pluginName,
		})
		collections.set(name, managed)
		this.ensureStream(pluginName, name, owner)
		void managed
			.ready()
			.then((): undefined => {
				this.broadcast(pluginName, 'snapshot', managed.snapshotEvent())
				return undefined
			})
			.catch((error) => {
				owner.logger.error('management collection initialization failed', {
					pluginName,
					collection: name,
					error,
				})
			})

		owner.effects.defer(() => {
			const currentCollections = this.collectionsByPlugin.get(pluginName)
			if (currentCollections?.get(name) === managed) {
				currentCollections.delete(name)
				if (currentCollections.size === 0) {
					this.collectionsByPlugin.delete(pluginName)
					this.ownersByPlugin.delete(pluginName)
				}
			}
			this.disposeStream(pluginName, name)
			void managed.dispose().catch((error) => {
				owner.logger.warn('management collection cleanup failed', {
					pluginName,
					collection: name,
					error,
				})
			})
		})

		return managed.publicApi
	}

	/** @internal Internal sync transport entry used by the HMR/web bridge. */
	async loadCollectionSync<T extends SignalDbItem>(name: string): Promise<SignalDbLoadResponse<T>> {
		return await this.loadCollectionFor<T>(this.currentPluginName(), name)
	}

	async loadCollectionFor<T extends SignalDbItem>(
		pluginName: string,
		name: string,
	): Promise<SignalDbLoadResponse<T>> {
		const managed = this.collectionsFor(pluginName).get(name)
		if (!managed) return { items: [], meta: { clientWrites: false } }
		const owner = this.ownersByPlugin.get(pluginName)
		if (owner) this.ensureStream(pluginName, name, owner)
		await managed.ready()
		return managed.loadSyncResponse() as SignalDbLoadResponse<T>
	}

	/** @internal Internal sync transport entry used by the HMR/web bridge. */
	async applyCollectionSyncChanges<T extends SignalDbItem>(
		name: string,
		changes: Changeset<T>,
	): Promise<'applied' | 'readonly' | 'missing'> {
		return await this.applyCollectionFor(this.currentPluginName(), name, changes)
	}

	async applyCollectionFor<T extends SignalDbItem>(
		pluginName: string,
		name: string,
		changes: Changeset<T>,
	): Promise<'applied' | 'readonly' | 'missing'> {
		const managed = this.collectionsFor(pluginName).get(name)
		if (!managed) return 'missing'
		const owner = this.ownersByPlugin.get(pluginName)
		if (owner) this.ensureStream(pluginName, name, owner)
		await managed.ready()
		if (!managed.allowsClientWrites()) return 'readonly'
		managed.applySyncChanges(changes)
		return 'applied'
	}

	private ensureStream(pluginName: string, collection: string, owner: Context) {
		const key = collectionKey(pluginName, collection)
		if (this.streamDisposers.has(key)) return

		const dispose = this.streams.registerResourceFor(
			owner,
			signalDbNamespace(pluginName, collection),
			(channel) => {
				const channels = this.channelsFor(pluginName, collection)
				channels.add(channel)
				const managed = this.collectionsFor(pluginName).get(collection)
				if (managed) {
					void managed
						.ready()
						.then((): undefined => {
							if (channel.closed || !channels.has(channel)) return undefined
							channel.emit('snapshot', managed.snapshotEvent())
							return undefined
						})
						.catch((error) => {
							owner.logger.error('management collection initial stream snapshot failed', {
								pluginName,
								collection: managed.publicApi.name,
								error,
							})
						})
				}
				channel.onAbort(() => {
					channels.delete(channel)
				})

				return () => {
					channels.delete(channel)
				}
			},
		)
		this.streamDisposers.set(key, dispose)
	}

	private disposeStream(pluginName: string, collection: string) {
		const key = collectionKey(pluginName, collection)
		this.streamDisposers.get(key)?.()
		this.streamDisposers.delete(key)
		this.channelsByCollection.delete(key)
	}

	broadcast(
		pluginName: string,
		event: Extract<
			SignalDbSyncEvent['type'],
			'snapshot' | 'insert' | 'update' | 'remove' | 'reset'
		>,
		payload: SignalDbSyncEvent,
	) {
		for (const channel of this.channelsFor(pluginName, payload.collection)) {
			try {
				channel.emit(event, payload)
			} catch (error) {
				this.ownersByPlugin.get(pluginName)?.logger.warn('management collection broadcast failed', {
					pluginName,
					collection: payload.collection,
					event,
					error,
				})
			}
		}
	}

	private currentPluginName(): string {
		return String(this.ctx.pluginInfo.id ?? '').trim()
	}

	private collectionsFor(pluginName: string): Map<string, ManagedSignalDbCollection<any>> {
		let collections = this.collectionsByPlugin.get(pluginName)
		if (!collections) {
			collections = new Map()
			this.collectionsByPlugin.set(pluginName, collections)
		}
		return collections
	}

	private channelsFor(pluginName: string, collection: string): Set<SseChannel> {
		const key = collectionKey(pluginName, collection)
		let channels = this.channelsByCollection.get(key)
		if (!channels) {
			channels = new Set()
			this.channelsByCollection.set(key, channels)
		}
		return channels
	}
}

function collectionKey(pluginName: string, collection: string): string {
	return `${pluginName}\u0000${collection}`
}

type ManagedCollectionOptions<T extends SignalDbItem> = SignalDbCollectionOptions<T> & {
	name: string
	pluginName: string
}

class ManagedSignalDbCollection<T extends SignalDbItem> {
	private collection: Collection<T, string, T> | null = null
	private readonly readyPromise: Promise<void>
	private version = 0
	private initialized = false
	private readonly listeners = new Set<(event: SignalDbSyncEvent<T>) => void>()

	readonly publicApi: SignalDbCollectionHandle<T>

	constructor(
		private readonly ctx: Context,
		private readonly owner: ManagementCollectionService,
		private readonly options: ManagedCollectionOptions<T>,
	) {
		this.readyPromise = this.init()
		this.publicApi = {
			name: options.name,
			ready: () => this.ready(),
			watch: (listener) => this.watch(listener),
			doc: (selector) => this.doc(selector),
			find: (selector, findOptions) => this.find(selector, findOptions),
			findOne: (selector) => this.findOne(selector),
			count: (selector) => this.count(selector),
			insert: (item) => this.insert(item),
			insertMany: (items) => this.insertMany(items),
			updateOne: (selector, modifier, updateOptions) =>
				this.updateOne(selector, modifier, updateOptions),
			replaceOne: (selector, replacement, replaceOptions) =>
				this.replaceOne(selector, replacement, replaceOptions),
			removeOne: (selector) => this.removeOne(selector),
			removeMany: (selector) => this.removeMany(selector),
			reset: (items) => this.reset(items),
			insertSpec: (value) => this.insertSpec(value),
			patchSpec: (selector, value, writeOptions) => this.patchSpec(selector, value, writeOptions),
			replaceSpec: (selector, value, writeOptions) =>
				this.replaceSpec(selector, value, writeOptions),
			removeSpec: (selector) => this.removeSpec(selector),
		}
	}

	async ready(): Promise<void> {
		await this.readyPromise
	}

	async dispose(): Promise<void> {
		try {
			await this.readyPromise
		} catch (error) {
			this.ctx.logger.warn('management collection cleanup after initialization failure', {
				pluginName: this.options.pluginName,
				collection: this.options.name,
				error,
			})
		}
		const collection = this.collection
		if (!collection) return
		while (collection.isPushing()) {
			await new Promise<void>((resolve) => {
				collection.once('persistence.pushCompleted', resolve)
			})
		}
		try {
			await collection.dispose()
		} catch (error) {
			this.ctx.logger.warn('management collection SignalDB cleanup failed', {
				pluginName: this.options.pluginName,
				collection: this.options.name,
				error,
			})
		}
	}

	snapshotEvent(): SignalDbSyncEvent<T> {
		return {
			type: 'snapshot',
			collection: this.options.name,
			version: this.version,
			items: this.snapshotItems(),
		}
	}

	loadSyncResponse(): SignalDbLoadResponse<T> {
		return {
			items: this.snapshotItems(),
			meta: {
				clientWrites: this.allowsClientWrites(),
			},
		}
	}

	allowsClientWrites() {
		return this.options.clientWrites === true
	}

	private async init() {
		const persistence =
			this.options.persistence === true
				? await this.ctx.pluginData.persistenceForCollection<T>(this.options.name)
				: undefined
		const collection = new SignalCollection<T, string, T>({
			name: this.options.name,
			persistence,
		})
		this.collection = collection

		await collection.isReady()

		const initialCursor = collection.find()
		let empty: boolean
		try {
			empty = initialCursor.count() === 0
		} finally {
			initialCursor.cleanup()
		}
		if (empty) {
			const seeded =
				typeof this.options.initial === 'function' ? this.options.initial() : this.options.initial
			if (Array.isArray(seeded) && seeded.length > 0) {
				collection.insertMany(seeded)
				this.bumpVersion()
			}
		}

		this.initialized = true
	}

	private assertReady() {
		if (!this.initialized || !this.collection) {
			throw new Error(
				`[management] collection "${this.options.name}" is not ready; await collection.ready() first`,
			)
		}
	}

	private getCollection(): Collection<T, string, T> {
		this.assertReady()
		return this.collection as Collection<T, string, T>
	}

	private bumpVersion() {
		this.version += 1
		return this.version
	}

	private snapshotItems() {
		return this.fetchItems()
	}

	private fetchItems(selector: SignalDbSelector<T> = {}, options?: SignalDbFindOptions<T>): T[] {
		const cursor = this.getCollection().find(selector as any, options as any)
		try {
			return cursor.fetch().map(cloneItem)
		} finally {
			cursor.cleanup()
		}
	}

	private countItems(selector: SignalDbSelector<T> = {}): number {
		const cursor = this.getCollection().find(selector as any)
		try {
			return cursor.count()
		} finally {
			cursor.cleanup()
		}
	}

	private emit(event: SignalDbSyncEvent<T>) {
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch (error) {
				this.ctx.logger.error('management collection listener failed', {
					pluginName: this.options.pluginName,
					collection: this.options.name,
					event: event.type,
					error,
				})
			}
		}
	}

	watch(listener: (event: SignalDbSyncEvent<T>) => void): () => void {
		let active = true
		this.listeners.add(listener)
		if (this.initialized) {
			listener(this.snapshotEvent())
		} else {
			void this.ready()
				.then((): undefined => {
					if (!active || !this.listeners.has(listener)) return undefined
					listener(this.snapshotEvent())
					return undefined
				})
				.catch((error) => {
					this.ctx.logger.error('management collection initial listener snapshot failed', {
						pluginName: this.options.pluginName,
						collection: this.options.name,
						error,
					})
				})
		}
		return () => {
			active = false
			this.listeners.delete(listener)
		}
	}

	doc(selector: SignalDbSelector<T>): SignalDbDocumentHandle<T> {
		const selection = cloneSelector(selector) as SignalDbSelector<T>
		return createSignalDbDocumentHandle(this.publicApi, selection)
	}

	find(selector: SignalDbSelector<T> = {}, options?: SignalDbFindOptions<T>): T[] {
		return this.fetchItems(selector, options)
	}

	findOne(selector: SignalDbSelector<T>): T | undefined {
		const item = this.getCollection().findOne(selector as any)
		return item ? cloneItem(item) : undefined
	}

	count(selector: SignalDbSelector<T> = {}): number {
		return this.countItems(selector)
	}

	insert(item: T): string {
		const collection = this.getCollection()
		const id = collection.insert(cloneItem(item))
		const inserted = collection.findOne({ id } as any)
		const version = this.bumpVersion()
		const event: SignalDbSyncEvent<T> = {
			type: 'insert',
			collection: this.options.name,
			version,
			items: inserted ? [cloneItem(inserted)] : [],
		}
		this.owner.broadcast(this.options.pluginName, 'insert', event)
		this.emit(event)
		return id
	}

	insertMany(items: T[]): string[] {
		const collection = this.getCollection()
		const ids = collection.insertMany(items.map(cloneItem))
		const inserted = ids
			.map((id) => collection.findOne({ id } as any))
			.filter(Boolean)
			.map((item) => cloneItem(item as T))
		const version = this.bumpVersion()
		const event: SignalDbSyncEvent<T> = {
			type: 'insert',
			collection: this.options.name,
			version,
			items: inserted,
		}
		this.owner.broadcast(this.options.pluginName, 'insert', event)
		this.emit(event)
		return ids
	}

	updateOne(
		selector: SignalDbSelector<T>,
		modifier: SignalDbModifier<T>,
		options?: { upsert?: boolean },
	): 0 | 1 {
		const collection = this.getCollection()
		const before = collection.findOne(selector as any)
		const result = collection.updateOne(selector as any, modifier as any, options)
		if (!result) return 0

		const updatedId = before?.id ?? asIdFromSelector(selector)
		const updated = updatedId
			? collection.findOne({ id: updatedId } as any)
			: collection.findOne(selector as any)
		const version = this.bumpVersion()
		const event: SignalDbSyncEvent<T> = {
			type: 'update',
			collection: this.options.name,
			version,
			items: updated ? [cloneItem(updated)] : [],
		}
		this.owner.broadcast(this.options.pluginName, 'update', event)
		this.emit(event)
		return result
	}

	replaceOne(selector: SignalDbSelector<T>, replacement: T, options?: { upsert?: boolean }): 0 | 1 {
		const collection = this.getCollection()
		const result = collection.replaceOne(selector as any, cloneItem(replacement), options)
		if (!result) return 0
		const updatedId = replacement.id || asIdFromSelector(selector)
		const updated = updatedId
			? collection.findOne({ id: updatedId } as any)
			: collection.findOne(selector as any)
		const version = this.bumpVersion()
		const event: SignalDbSyncEvent<T> = {
			type: 'update',
			collection: this.options.name,
			version,
			items: updated ? [cloneItem(updated)] : [],
		}
		this.owner.broadcast(this.options.pluginName, 'update', event)
		this.emit(event)
		return result
	}

	removeOne(selector: SignalDbSelector<T>): 0 | 1 {
		const collection = this.getCollection()
		const before = collection.findOne(selector as any)
		const result = collection.removeOne(selector as any)
		if (!result) return 0
		const version = this.bumpVersion()
		const event: SignalDbSyncEvent<T> = {
			type: 'remove',
			collection: this.options.name,
			version,
			ids: before?.id ? [before.id] : [],
		}
		this.owner.broadcast(this.options.pluginName, 'remove', event)
		this.emit(event)
		return result
	}

	removeMany(selector: SignalDbSelector<T>): number {
		const collection = this.getCollection()
		const matched = this.fetchItems(selector).map((item) => item.id)
		const removed = collection.removeMany(selector as any)
		if (!removed) return 0
		const version = this.bumpVersion()
		const event: SignalDbSyncEvent<T> = {
			type: 'remove',
			collection: this.options.name,
			version,
			ids: matched,
		}
		this.owner.broadcast(this.options.pluginName, 'remove', event)
		this.emit(event)
		return removed
	}

	reset(items: T[]) {
		const collection = this.getCollection()
		collection.removeMany({})
		if (items.length > 0) collection.insertMany(items.map(cloneItem))
		const version = this.bumpVersion()
		const event: SignalDbSyncEvent<T> = {
			type: 'reset',
			collection: this.options.name,
			version,
			items: this.snapshotItems(),
		}
		this.owner.broadcast(this.options.pluginName, 'reset', event)
		this.emit(event)
	}

	insertSpec(value: BuiltinTemplateValue): BuiltinSignalDbWriteSpec {
		return {
			collection: this.options.name,
			mode: 'insert',
			value,
		}
	}

	patchSpec(
		selector: SignalDbSelector<T>,
		value: BuiltinTemplateValue,
		options?: { upsert?: boolean },
	): BuiltinSignalDbWriteSpec {
		return {
			collection: this.options.name,
			mode: 'patch',
			selector: cloneSelector(selector),
			upsert: options?.upsert,
			value,
		}
	}

	replaceSpec(
		selector: SignalDbSelector<T>,
		value: BuiltinTemplateValue,
		options?: { upsert?: boolean },
	): BuiltinSignalDbWriteSpec {
		return {
			collection: this.options.name,
			mode: 'replace',
			selector: cloneSelector(selector),
			upsert: options?.upsert,
			value,
		}
	}

	removeSpec(selector: SignalDbSelector<T>): BuiltinSignalDbWriteSpec {
		return {
			collection: this.options.name,
			mode: 'remove',
			selector: cloneSelector(selector),
		}
	}

	applySyncChanges(changes: Changeset<T>) {
		const collection = this.getCollection()

		const addedItems = sanitizeSyncItems(changes.added)
		const modifiedItems = sanitizeSyncItems(changes.modified)
		const removedIds = sanitizeSyncItems(changes.removed).map((item) => item.id)
		const addedIds = addedItems.map((item) => item.id)
		const modifiedIds = modifiedItems.map((item) => item.id)

		if (addedIds.length === 0 && modifiedIds.length === 0 && removedIds.length === 0) return

		const nextAddedItems = new Map(addedItems.map((item) => [item.id, item]))
		const nextModifiedItems = new Map(modifiedItems.map((item) => [item.id, item]))

		collection.batch(() => {
			for (const item of nextAddedItems.values()) {
				collection.replaceOne({ id: item.id } as any, cloneItem(item), { upsert: true })
			}
			for (const item of nextModifiedItems.values()) {
				collection.replaceOne({ id: item.id } as any, cloneItem(item), { upsert: true })
			}
			for (const id of removedIds) {
				collection.removeOne({ id } as any)
			}
		})

		const version = this.bumpVersion()
		const added = resolveItemsByIds(collection, addedIds)
		const modified = resolveItemsByIds(collection, modifiedIds)
		if (added.length > 0) {
			const event: SignalDbSyncEvent<T> = {
				type: 'insert',
				collection: this.options.name,
				version,
				items: added,
			}
			this.owner.broadcast(this.options.pluginName, 'insert', event)
			this.emit(event)
		}
		if (modified.length > 0) {
			const event: SignalDbSyncEvent<T> = {
				type: 'update',
				collection: this.options.name,
				version,
				items: modified,
			}
			this.owner.broadcast(this.options.pluginName, 'update', event)
			this.emit(event)
		}
		if (removedIds.length > 0) {
			const event: SignalDbSyncEvent<T> = {
				type: 'remove',
				collection: this.options.name,
				version,
				ids: removedIds,
			}
			this.owner.broadcast(this.options.pluginName, 'remove', event)
			this.emit(event)
		}
	}
}

function createSignalDbDocumentHandle<TState extends SignalDbItem>(
	collection: SignalDbCollectionHandle<TState>,
	selector: SignalDbSelector<TState>,
): SignalDbDocumentHandle<TState> {
	const selection = cloneSelector(selector) as SignalDbSelector<TState>
	return {
		collection: collection.name,
		selector: selection,
		get: () => collection.findOne(selection),
		field(key, fallback) {
			return createSignalDbRef(collection.name, selection, key, fallback)
		},
		path(path, fallback) {
			return createSignalDbRef(collection.name, selection, path, fallback)
		},
		snapshot(fallback) {
			return createSignalDbDocRef(collection.name, selection, fallback)
		},
		form(input) {
			return createBuiltinFormBlock(
				input,
				createSignalDbDocRef(collection.name, selection, {} as Record<string, unknown>),
			)
		},
		formFrom(syncFrom, input) {
			const normalizedSyncFrom = isBuiltinSyncRef(syncFrom)
				? syncFrom
				: createSignalDbDocRef(collection.name, selection, syncFrom as TState)
			return createBuiltinFormBlock(input, normalizedSyncFrom)
		},
		formUnsynced(input) {
			return createBuiltinFormBlock(input)
		},
		action(input) {
			return {
				...input,
				kind: 'action',
			}
		},
		patchSpec(value, options) {
			return collection.patchSpec(selection, value, options)
		},
		replaceSpec(value, options) {
			return collection.replaceSpec(selection, value, options)
		},
		removeSpec() {
			return collection.removeSpec(selection)
		},
	}
}

function createBuiltinFormBlock(
	input: Omit<BuiltinFormBlock, 'kind' | 'syncFrom'>,
	syncFrom?: BuiltinSyncRef<Record<string, unknown>>,
): BuiltinFormBlock {
	return {
		...input,
		kind: 'form',
		syncFrom,
	}
}

function cloneSelector<T extends SignalDbItem>(
	selector: SignalDbSelector<T>,
): Record<string, unknown> {
	return { ...(selector as Record<string, unknown>) }
}

function createSignalDbRef<TValue>(
	collection: string,
	selector: Record<string, unknown>,
	path: string,
	fallback: TValue,
): BuiltinSyncRef<TValue> {
	return {
		kind: 'signaldb',
		collection,
		selector: { ...selector },
		path: path.trim(),
		fallback,
	}
}

function createSignalDbDocRef<T>(
	collection: string,
	selector: Record<string, unknown>,
	fallback: T,
): BuiltinSyncRef<T> {
	return {
		kind: 'signaldb',
		collection,
		selector: { ...selector },
		fallback,
	}
}

function isBuiltinSyncRef(value: unknown): value is BuiltinSyncRef<Record<string, unknown>> {
	if (!value || typeof value !== 'object') return false
	return (value as { kind?: unknown }).kind === 'signaldb'
}

function cloneItem<T>(item: T): T {
	return item && typeof item === 'object' ? ({ ...(item as Record<string, unknown>) } as T) : item
}

function sanitizeSyncItems<T extends SignalDbItem>(items: readonly T[] | undefined): T[] {
	if (!Array.isArray(items)) return []
	return items
		.filter((item): item is T => !!item && typeof item.id === 'string' && item.id.length > 0)
		.map((item) => cloneItem(item))
}

function resolveItemsByIds<T extends SignalDbItem>(
	collection: Collection<T, string, T>,
	ids: readonly string[],
): T[] {
	const uniqueIds = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
	return uniqueIds
		.map((id) => collection.findOne({ id } as any))
		.filter(Boolean)
		.map((item) => cloneItem(item as T))
}

function asIdFromSelector<T extends SignalDbItem>(
	selector: SignalDbSelector<T>,
): string | undefined {
	return typeof selector.id === 'string' ? selector.id : undefined
}
