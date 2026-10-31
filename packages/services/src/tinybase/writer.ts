import type { Context, PluginContext } from '@pluxel/core'
import { enterOwnerInvocation } from '@pluxel/core/host'
import type { HostDocumentStorage } from '@pluxel/host'
import { createStore, type Content, type Store } from 'tinybase'
import type { OptionalSchemas, Store as SchemaStore } from 'tinybase/with-schemas'
import { decodeSnapshot, encodeSnapshot, sameContent } from './codec'
import { TinyBaseError } from './error'
import type { TinyBaseIdentity, TinyBaseService, TinyBaseStatus } from './types'

type Snapshot = { revision: number; content: Content; text: string }
// Retired instances remain marked: a stale generation's Store must never become another writer.
const storeOwners = new WeakMap<object, object>()

export class StoreWriter implements TinyBaseService {
	readonly identity: TinyBaseIdentity
	private store?: Store
	private opening?: Promise<Store>
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

	constructor(
		readonly ctx: PluginContext,
		private readonly documents: HostDocumentStorage,
		private readonly file: string,
		private readonly maxBytes: number,
		private readonly claim: () => void,
		private readonly release: () => void,
	) {
		this.identity = Object.freeze({ kind: 'plugin', node: ctx.pluginInfo.nodeAddress })
		// Registration precedes the first open await, including an acquisition that resolves after stop.
		ctx.effects.defer(() => this.close(), { tag: 'TinyBaseStore', phase: 'final' })
	}

	open(): Promise<Store>
	open<TStore extends Store>(store: TStore): Promise<TStore>
	open<TSchemas extends OptionalSchemas>(
		store: SchemaStore<TSchemas>,
	): Promise<SchemaStore<TSchemas>>
	open(input?: unknown): Promise<unknown> {
		return this.run(async (signal) => {
			this.assertUsable()
			if (this.opening) {
				if (input !== undefined && input !== this.store)
					throw this.error(
						'OPEN_CONFLICT',
						'This Plugin generation already opened a different Store.',
					)
			} else {
				const store = input === undefined ? createStore() : input
				if (typeof store === 'object' && store !== null && storeOwners.has(store))
					throw this.error(
						'STORE_IN_USE',
						'The Store already belongs to a current or retired generation.',
					)
				assertFreshStore(store, this.identity)
				this.claim()
				storeOwners.set(store, this)
				this.store = store
				this.opening = this.restore(store, signal)
			}
			const store = await this.opening
			signal.throwIfAborted()
			this.assertUsable()
			return store
		})
	}

	flush(): Promise<void> {
		return this.run(async () => {
			this.assertUsable()
			if (!this.opening) throw this.error('NOT_OPEN', 'Call open() before flush().')
			// A ready Store must capture synchronously: an already-resolved Promise still yields.
			let snapshot = this.last
			if (!snapshot) {
				await this.opening
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
			...(this.fault ? { error: this.fault } : {}),
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
					if (this.closing || this.fault) return
					try {
						const content = store.getContent()
						if (sameContent(content, this.last!.content)) return
						this.revision++
						this.last = this.snapshot(content)
						if (this.published) {
							this.enqueue(this.last)
							this.schedule()
						}
					} catch (cause) {
						this.fail(cause)
					}
				}),
			)
			if (this.published) {
				this.enqueue(this.last)
				this.schedule()
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

	private snapshot(content = this.store!.getContent()): Snapshot {
		return {
			revision: this.revision,
			content,
			text: encodeSnapshot(this.identity, content, this.maxBytes),
		}
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
			try {
				await this.opening?.catch((): undefined => undefined)
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
		})()
		return this.disposal
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

	private async run<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		return runOperation(this.ctx, run)
	}
}

export async function runOperation<T>(
	ctx: Context,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const root = enterOwnerInvocation(ctx.root)
	try {
		const owner = ctx === ctx.root ? undefined : enterOwnerInvocation(ctx, root.signal)
		try {
			return await run(owner?.signal ?? root.signal)
		} finally {
			owner?.dispose()
		}
	} finally {
		root.dispose()
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
			'isMergeable',
			'getListenerStats',
			'transaction',
			'addStartTransactionListener',
			'addDidFinishTransactionListener',
			'delListener',
		].every((key) => typeof Reflect.get(input, key) === 'function')
	)
}
