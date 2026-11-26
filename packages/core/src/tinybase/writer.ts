import type { Context, PluginContext } from '../context/Context'
import { assertCoreConfigObject } from '../context/core-config-object'
import {
	admitOwnerInvocation,
	releaseOwnerInvocation,
	type OwnerInvocationAdmission,
} from '../internal/owner-invocations'
import type { CoreStorage, CoreDocumentStorage } from '../storage/documents'
import {
	createStore,
	type Content,
	type Store,
	type TablesSchema,
	type ValuesSchema,
} from 'tinybase'
import type { OptionalSchemas, Store as SchemaStore } from 'tinybase/with-schemas'
import { decodeSnapshot, encodeStoreSnapshot, sameContent } from './codec'
import { TinyBaseError } from './error'
import type {
	TinyBaseIdentity,
	TinyBaseService,
	TinyBaseStatus,
	TinyBaseSuppliedStore,
} from './types'

type Snapshot = { revision: number; text: string }
// Retired instances remain marked: a stale generation's Store must never become another writer.
const usedStores = new WeakSet<object>()
const openFields = new Set(['durable', 'store'])

export class StoreWriter implements TinyBaseService {
	readonly identity: TinyBaseIdentity
	private store?: Store
	private opening?: { result: Promise<Store>; signal: AbortSignal }
	private listenerIds: string[] = []
	private transaction = false
	private published = false
	private closing = false
	private disposal?: Promise<void>
	private revision = 0
	private savedRevision = 0
	private last?: Snapshot
	private pending?: Snapshot
	private saving?: Snapshot
	private inFlight?: Promise<void>
	private fault?: TinyBaseError
	private recovery?: { action: 'retry' | 'discard'; promise: Promise<void> }
	private recovered = false
	private outcome: 'confirmed' | 'unknown' = 'confirmed'
	private scheduled = false
	private loading = false
	private unsubscribe?: () => void
	private reloadPending = false
	private reloading?: Promise<void>
	private retryRead?: ReturnType<typeof setTimeout>
	private reloadError?: unknown

	constructor(
		readonly ctx: PluginContext,
		private readonly documents: CoreDocumentStorage,
		private readonly retention: ReturnType<CoreStorage['documents']['documentRetention']>,
		private readonly file: string,
		private readonly maxBytes: number,
		private readonly claim: () => void,
		private readonly release: () => void,
	) {
		this.identity = Object.freeze({ kind: 'plugin', node: ctx.pluginInfo.nodeAddress })
		// Registration precedes the first open await, including an acquisition that resolves after stop.
		ctx.effects.defer(() => this.close(), { tag: 'TinyBaseStore', phase: 'final' })
	}

	open(options?: Readonly<{ durable: true; store?: undefined }>): Promise<Store>
	open<TStore extends Store>(input: TinyBaseSuppliedStore<TStore>): Promise<TStore>
	open<TSchemas extends OptionalSchemas>(
		input: TinyBaseSuppliedStore<SchemaStore<TSchemas>>,
	): Promise<SchemaStore<TSchemas>>
	open(input?: unknown): Promise<unknown> {
		return runOperation(this.ctx, async (root, owner) => {
			this.assertUsable()
			if (input && typeof input === 'object' && 'durable' in input && !('getContent' in input)) {
				assertCoreConfigObject(input, '[core.tinybase] open options', openFields)
				if (!Object.hasOwn(input, 'durable') || input.durable !== true)
					throw new TypeError('[core.tinybase] open options require durable: true')
				if (this.retention !== 'declared-durable')
					throw this.error(
						'DURABILITY_UNAVAILABLE',
						`Opening this Store requires durable backing. Snapshot directory retention is ${this.retention}.`,
					)
				input = Object.hasOwn(input, 'store') ? Reflect.get(input, 'store') : undefined
			}
			if (this.opening) {
				if (input !== undefined && input !== this.store)
					throw this.error(
						'OPEN_CONFLICT',
						'This Plugin generation already opened a different Store.',
					)
			} else {
				const store = input === undefined ? createStore() : input
				if (typeof store === 'object' && store !== null && usedStores.has(store))
					throw this.error(
						'STORE_IN_USE',
						'The Store already belongs to a current or retired generation.',
					)
				assertFreshStore(store, this.identity)
				const signal = owner ? AbortSignal.any([root.signal, owner.signal]) : root.signal
				this.claim()
				usedStores.add(store)
				this.store = store
				this.opening = { result: this.restore(store, signal), signal }
			}
			const opening = this.opening
			const store = await opening.result
			opening.signal.throwIfAborted()
			this.assertUsable()
			return store
		})
	}

	flush(): Promise<void> {
		return runOperation(this.ctx, async () => {
			this.assertUsable()
			if (!this.opening) throw this.error('NOT_OPEN', 'Call open() before flush().')
			// A ready Store must capture synchronously: an already-resolved Promise still yields.
			let snapshot = this.last
			if (!snapshot) {
				await this.opening.result
				this.assertUsable()
				snapshot = this.last!
			}
			if (this.transaction)
				throw this.error('TRANSACTION_ACTIVE', 'Finish the native transaction before flush().')
			this.enqueue(snapshot)
			await this.waitFor(snapshot.revision)
		})
	}

	/** Validate a publication candidate before Core's synchronous no-fail exchange. */
	preparePublication(): void {
		if (!this.opening || !this.last || this.closing) return
		this.assertUsable()
		if (this.transaction)
			throw this.error(
				'TRANSACTION_ACTIVE',
				'A generation cannot publish with an unfinished transaction.',
			)
	}

	/** Synchronous publication only enables the already-captured snapshot; IO runs in a microtask. */
	publish(): void {
		if (this.closing || this.fault) return
		this.published = true
		if (this.last) this.enqueue(this.last)
		this.schedule()
		if (this.last) queueMicrotask(() => this.observe())
	}

	status(): TinyBaseStatus {
		return Object.freeze({
			identity: this.identity,
			phase: this.fault
				? 'faulted'
				: this.closing
					? 'closed'
					: !this.last
						? 'opening'
						: this.published
							? 'active'
							: 'initializing',
			revision: this.revision,
			savedRevision: this.savedRevision,
			pendingRevision:
				this.pending?.revision ??
				this.saving?.revision ??
				(this.last && this.last.revision > this.savedRevision ? this.last.revision : undefined),
			outcome: this.outcome,
			...(this.fault || this.reloadError ? { error: this.fault ?? this.reloadError } : {}),
		})
	}

	recover(action: 'retry' | 'discard'): Promise<void> {
		if (!this.closing || !this.fault)
			return Promise.reject(
				this.error('WRITER_BLOCKED', 'Stop the faulted Plugin before recovering its writer.'),
			)
		if (this.recovered)
			return Promise.reject(
				this.error('CLOSED', 'This retired writer has already completed recovery.'),
			)
		if (this.recovery) {
			if (this.recovery.action !== action)
				return Promise.reject(
					this.error(
						'WRITER_BLOCKED',
						'Another recovery action is already in progress for this writer.',
					),
				)
			return this.recovery.promise
		}
		// Install the single-flight before invoking backing IO. A completed old writer must
		// never perform a second write after its replacement has acquired the node.
		const promise = Promise.resolve().then(async (): Promise<void> => {
			try {
				await this.disposal?.catch((): undefined => undefined)
				await this.inFlight?.catch((): undefined => undefined)
				if (action === 'retry') {
					const snapshot = this.pending ?? this.saving ?? this.last
					if (!snapshot) throw this.fault
					await this.documents.put(this.file, snapshot.text)
				} else {
					const text = await this.documents.getText(this.file)
					if (text !== undefined) decodeSnapshot(text, this.identity, this.maxBytes)
				}
				this.recovered = true
				this.release()
				return undefined
			} finally {
				this.recovery = undefined
			}
		})
		this.recovery = { action, promise }
		return promise
	}

	private async restore(store: Store, signal: AbortSignal): Promise<Store> {
		try {
			await this.documents.requireWritable?.()
			const text = await this.documents.getText(this.file)
			// A withdrawn acquisition must not publish a snapshot or enable autosave.
			signal.throwIfAborted()
			if (text !== undefined) {
				const content = decodeSnapshot(text, this.identity, this.maxBytes)
				store.setContent(content)
				if (!sameContent(content, store.getContent()))
					throw this.error(
						'SNAPSHOT_INVALID',
						'Native schema discarded or changed restored Content; migrate it explicitly.',
					)
			} else this.revision = 1
			this.last = this.snapshot()
			this.listenerIds.push(
				store.addStartTransactionListener(() => {
					this.transaction = true
				}),
				store.addDidFinishTransactionListener(() => {
					this.transaction = false
					if (this.closing || this.fault || this.loading) return
					try {
						const [changedTables, changedValues] = store.getTransactionChanges()
						if (Object.keys(changedTables).length === 0 && Object.keys(changedValues).length === 0)
							return
						this.revision++
						this.last = this.snapshot()
						if (this.published) {
							this.enqueue(this.last)
							this.schedule()
						}
					} catch (cause) {
						this.fail(cause)
					} finally {
						this.reloadIfIdle()
					}
				}),
			)
			if (this.published) {
				this.enqueue(this.last)
				this.schedule()
				this.observe()
			}
			return store
		} catch (cause) {
			for (const id of this.listenerIds.splice(0)) store.delListener(id)
			signal.throwIfAborted()
			throw this.error(
				'RESTORE_FAILED',
				'Cannot restore the Plugin Store; source data has been preserved.',
				cause,
			)
		}
	}

	private snapshot(): Snapshot {
		return {
			revision: this.revision,
			text: encodeStoreSnapshot(this.identity, this.store!, this.maxBytes),
		}
	}

	private observe(): void {
		if (!this.documents.subscribe || this.unsubscribe || this.closing) return
		const changed = () => {
			if (this.closing || this.fault) return
			clearTimeout(this.retryRead)
			this.retryRead = undefined
			this.reloadPending = true
			this.reloadIfIdle()
		}
		try {
			this.unsubscribe = this.documents.subscribe(changed, {
				key: this.file,
				onError: (error) => this.reportReloadError(error),
			})
		} catch (error) {
			this.reportReloadError(error)
			return
		}
		// Catch a write between restore and subscription, including a push-only backend.
		changed()
	}

	private reloadIfIdle(): void {
		if (
			!this.reloadPending ||
			this.reloading ||
			this.transaction ||
			this.inFlight ||
			this.pending ||
			this.fault ||
			this.closing
		)
			return
		this.reloadPending = false
		const revision = this.revision
		this.reloading = Promise.resolve()
			.then(() => this.readExternal(revision))
			.catch((error) => this.reportReloadError(error))
			.finally(() => {
				this.reloading = undefined
				this.reloadIfIdle()
			})
	}

	private async readExternal(revision: number): Promise<void> {
		let text: string | undefined
		try {
			text = await this.documents.getText(this.file)
		} catch (error) {
			if (this.closing || this.fault) return
			if (this.retryRead === undefined) this.reportReloadError(error)
			// A push backend may have sent its only notification. Retry the failed read
			// until confirmed; subsequent notifications supersede the timer.
			if (this.reloadPending) return
			clearTimeout(this.retryRead)
			this.retryRead = setTimeout(() => {
				this.reloadPending = true
				this.reloadIfIdle()
			}, 250)
			if (typeof this.retryRead === 'object' && 'unref' in this.retryRead) this.retryRead.unref()
			return
		}
		clearTimeout(this.retryRead)
		this.retryRead = undefined
		if (this.closing || this.fault) return
		if (this.transaction || this.inFlight || this.pending || this.revision !== revision) {
			this.reloadPending = true
			return
		}
		if (!this.reloadPending) this.applyExternal(text)
	}

	private reportReloadError(error: unknown): void {
		if (this.closing) return
		this.reloadError = error
		this.ctx.logger.error('Cannot reload TinyBase snapshot for {owner}', {
			owner: this.identity,
			error,
		})
	}

	private applyExternal(text: string | undefined): void {
		const content: Content =
			text === undefined ? [{}, {}] : decodeSnapshot(text, this.identity, this.maxBytes)
		const store = this.store!
		const candidate = createStore()
		if (store.hasTablesSchema())
			candidate.setTablesSchema(JSON.parse(store.getTablesSchemaJson()) as TablesSchema)
		if (store.hasValuesSchema())
			candidate.setValuesSchema(JSON.parse(store.getValuesSchemaJson()) as ValuesSchema)
		candidate.setContent(content)
		if (!sameContent(content, candidate.getContent()))
			throw this.error(
				'SNAPSHOT_INVALID',
				'External Content does not match the native schema; source data has been preserved.',
			)
		this.reloadError = undefined
		if (sameContent(content, store.getContent())) return
		this.revision++
		this.savedRevision = this.revision
		this.loading = true
		let listenerFailed = false
		let listenerError: unknown
		try {
			store.setContent(content)
		} catch (error) {
			listenerFailed = true
			listenerError = error
		} finally {
			this.loading = false
		}
		// Listener-authored mutations are local writes; loading the file itself never writes back.
		if (!sameContent(content, store.getContent())) this.revision++
		this.last = this.snapshot()
		this.enqueue(this.last)
		this.schedule()
		if (listenerFailed) throw listenerError
	}

	private enqueue(snapshot: Snapshot): void {
		if (this.saving && snapshot.revision <= this.saving.revision) return
		if (
			snapshot.revision > this.savedRevision &&
			(!this.pending || snapshot.revision >= this.pending.revision)
		)
			this.pending = snapshot
	}

	private schedule(): void {
		if (this.scheduled) return
		this.scheduled = true
		queueMicrotask(() => {
			this.scheduled = false
			if (this.published && !this.closing && !this.fault) this.startSave()
		})
	}

	private startSave(): void {
		if (this.inFlight || this.fault || !this.pending) return
		const snapshot = this.pending
		this.pending = undefined
		this.saving = snapshot
		this.inFlight = (async () => {
			try {
				await this.documents.put(this.file, snapshot.text)
				this.savedRevision = snapshot.revision
			} catch (cause) {
				this.outcome = 'unknown'
				this.fail(
					this.error(
						'SAVE_FAILED',
						'Snapshot save failed; outcome may be unknown. This writer is blocked until explicit recovery.',
						cause,
					),
				)
				this.pending ??= snapshot
				throw this.fault
			} finally {
				this.inFlight = undefined
				this.saving = undefined
				if (this.published && this.pending && !this.fault && !this.closing) this.schedule()
				this.reloadIfIdle()
			}
		})()
		// Autosave failures are supervised here; explicit flush and shutdown still reject the same error.
		void this.inFlight.catch(() => {})
	}

	private async waitFor(revision: number): Promise<void> {
		while (this.savedRevision < revision) {
			if (this.fault) throw this.fault
			this.startSave()
			await this.inFlight
		}
	}

	private close(): Promise<void> {
		if (this.disposal) return this.disposal
		this.closing = true
		this.disposal = (async () => {
			await using _drain = { [Symbol.asyncDispose]: () => this.drain() }
			clearTimeout(this.retryRead)
			this.unsubscribe?.()
		})()
		return this.disposal
	}

	private async drain(): Promise<void> {
		try {
			await this.reloading
			await this.opening?.result.catch((): undefined => undefined)
			for (const id of this.listenerIds.splice(0)) this.store!.delListener(id)
			await this.inFlight?.catch((): undefined => undefined)
			if (this.fault) throw this.fault
			if (this.published && this.last) {
				if (this.transaction) {
					this.fail(
						this.error(
							'TRANSACTION_ACTIVE',
							'Stopped with an unfinished native transaction; no partial transaction was saved.',
						),
					)
					throw this.fault
				}
				this.enqueue(this.last)
				await this.waitFor(this.last.revision)
			} else {
				// Explicit init flush may already have committed. Later uncommitted candidates are discarded.
				await this.inFlight
				this.pending = undefined
			}
		} finally {
			if (!this.fault) this.release()
		}
	}

	private fail(cause: unknown): void {
		if (this.fault) return
		this.fault =
			cause instanceof TinyBaseError
				? cause
				: this.error('SNAPSHOT_INVALID', 'Cannot capture a persistable snapshot.', cause)
		this.ctx.logger.error(
			'TinyBase writer fault for {owner}; saved revision {savedRevision}, current revision {revision}',
			{
				owner: this.identity,
				savedRevision: this.savedRevision,
				revision: this.revision,
				error: this.fault,
			},
		)
	}

	private assertUsable(): void {
		if (this.closing) throw this.error('CLOSED', 'This Plugin generation has withdrawn its writer.')
		if (this.fault) throw this.fault
	}

	private error(code: TinyBaseError['code'], message: string, cause?: unknown): TinyBaseError {
		return new TinyBaseError(
			code,
			message,
			this.identity,
			cause === undefined ? undefined : { cause },
		)
	}
}

export async function runOperation<T>(
	ctx: Context,
	run: (root: OwnerInvocationAdmission, owner?: OwnerInvocationAdmission) => Promise<T>,
): Promise<T> {
	const root = admitOwnerInvocation(ctx.root)
	try {
		const owner = ctx === ctx.root ? undefined : admitOwnerInvocation(ctx)
		try {
			return await run(root, owner)
		} finally {
			if (owner) releaseOwnerInvocation(owner)
		}
	} finally {
		releaseOwnerInvocation(root)
	}
}

function assertFreshStore(store: unknown, identity: TinyBaseIdentity): asserts store is Store {
	if (!nativeStore(store) || store.isMergeable())
		throw new TinyBaseError(
			'INVALID_STORE',
			'open() accepts a fresh ordinary native Store.',
			identity,
		)
	if (Object.values(store.getListenerStats()).some((count) => count !== 0))
		throw new TinyBaseError(
			'INVALID_STORE',
			'Attach Queries, listeners, Persisters and Synchronizers only after open(); Host owns persistence.',
			identity,
		)
	let started = false
	const id = store.addStartTransactionListener(() => {
		started = true
	})
	try {
		store.transaction(() => {})
	} finally {
		store.delListener(id)
	}
	if (!started)
		throw new TinyBaseError(
			'TRANSACTION_ACTIVE',
			'Finish the native transaction before open().',
			identity,
		)
}

// Upstream's schema and ordinary declarations describe the same runtime object. Validate
// the native methods used here before erasing schema types for snapshot capture/restore.
function nativeStore(input: unknown): input is Store {
	return (
		typeof input === 'object' &&
		input !== null &&
		[
			'getContent',
			'setContent',
			'forEachTable',
			'forEachValue',
			'getTransactionChanges',
			'isMergeable',
			'getListenerStats',
			'transaction',
			'addStartTransactionListener',
			'addDidFinishTransactionListener',
			'delListener',
		].every((key) => typeof Reflect.get(input, key) === 'function')
	)
}
