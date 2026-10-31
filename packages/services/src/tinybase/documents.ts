import type { HostDocumentStorage } from '@pluxel/host'
import { createStore, type Store } from 'tinybase'
import { decodeSnapshot, encodeSnapshot, sameContent } from './codec'
import { TinyBaseError } from './error'
import type { TinyBaseIdentity, TinyBaseStatus } from './types'

/** Host documents have a confirmed read view; failed candidates never enter the backing Store. */
export class HostDocuments implements HostDocumentStorage {
	private readonly identity: TinyBaseIdentity
	private store?: Store
	private preparation?: Promise<Store>
	private tail: Promise<unknown> = Promise.resolve()
	private revision = 0
	private pendingRevision?: number
	private fault?: TinyBaseError
	private outcome: 'confirmed' | 'unknown' = 'confirmed'
	private closed = false

	constructor(
		namespace: string,
		private readonly backing: HostDocumentStorage,
		private readonly file: string,
		private readonly maxBytes: number,
		private readonly assertWritable: () => Promise<void>,
	) {
		this.identity = Object.freeze({ kind: 'host', namespace })
	}

	async getText(key: string): Promise<string | undefined> {
		assertKey(key)
		this.assertOpen()
		const store = await this.ready()
		this.assertOpen()
		return store.getCell('documents', key, 'text') as string | undefined
	}

	put(key: string, text: string): Promise<void> {
		assertKey(key)
		if (typeof text !== 'string')
			throw new TypeError('[services.tinybase] document content must be a string')
		this.assertOpen()
		// Serialize the whole read/modify/save/confirm, including concurrent different-key puts.
		const task = this.tail.then(async (): Promise<void> => {
			if (this.fault) throw this.fault
			await this.assertWritable()
			const confirmed = await this.ready()
			const candidate = documentStore()
				.setContent(confirmed.getContent())
				.setRow('documents', key, { text })
			if (candidate.getCell('documents', key, 'text') !== text)
				throw new TinyBaseError(
					'SNAPSHOT_INVALID',
					'The document key was rejected by the native Store.',
					this.identity,
				)
			const content = candidate.getContent()
			const encoded = encodeSnapshot(this.identity, content, this.maxBytes)
			this.pendingRevision = this.revision + 1
			try {
				await this.backing.put(this.file, encoded)
			} catch (cause) {
				this.outcome = 'unknown'
				this.fault = new TinyBaseError(
					'SAVE_FAILED',
					'Host document save failed; candidate was not published. Reopen the Host to inspect the actual backing.',
					this.identity,
					{ cause },
				)
				throw this.fault
			}
			this.store = candidate
			this.revision++
			this.pendingRevision = undefined
			return undefined
		})
		this.tail = task.catch(() => {})
		return task
	}

	async stat(key: string): Promise<object | undefined> {
		return (await this.getText(key)) === undefined ? undefined : {}
	}

	status(): TinyBaseStatus {
		return Object.freeze({
			identity: this.identity,
			phase: this.fault ? 'faulted' : this.closed ? 'closed' : this.store ? 'active' : 'opening',
			revision: this.revision,
			savedRevision: this.revision,
			pendingRevision: this.pendingRevision,
			outcome: this.outcome,
			...(this.fault ? { error: this.fault } : {}),
		})
	}

	async close(): Promise<void> {
		this.closed = true
		await this.tail
		await this.preparation?.catch((): undefined => undefined)
		// Never retry a failed candidate during close.
		if (this.fault) throw this.fault
	}

	private ready(): Promise<Store> {
		if (this.store) return Promise.resolve(this.store)
		this.preparation ??= (async () => {
			const store = documentStore()
			const text = await this.backing.getText(this.file)
			if (text !== undefined) {
				const content = decodeSnapshot(text, this.identity, this.maxBytes)
				store.setContent(content)
				if (!sameContent(content, store.getContent()))
					throw new TinyBaseError(
						'SNAPSHOT_INVALID',
						'Host document snapshot does not match its native schema.',
						this.identity,
					)
			}
			this.store = store
			return store
		})().catch((cause: unknown) => {
			this.fault = new TinyBaseError(
				'RESTORE_FAILED',
				'Cannot restore Host documents; source data has been preserved.',
				this.identity,
				{ cause },
			)
			throw this.fault
		})
		return this.preparation
	}

	private assertOpen(): void {
		if (this.closed)
			throw new TinyBaseError('CLOSED', 'Host document namespace is closed.', this.identity)
	}
}

function documentStore(): Store {
	return createStore()
		.setTablesSchema({ documents: { text: { type: 'string' } } })
		.setValuesSchema({})
}

function assertKey(key: string): void {
	if (typeof key !== 'string' || key.length === 0 || key.length > 16_384)
		throw new TypeError('[services.tinybase] document key must contain 1 to 16384 characters')
}
