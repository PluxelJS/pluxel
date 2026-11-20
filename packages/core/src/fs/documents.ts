import { withErrno } from 'kerium'
import {
	assertDocumentBudget,
	assertDocumentKey,
	type HostDocumentStorage,
} from '../storage/documents'
import { writeFileAtomic } from './atomic'
import { observeFile } from './observe'
import type { FsPromises, FsRequirement } from './service'

/** Ordinary files: domains own decoding and confirmed state; this owner drains accepted IO. */
export class FsDocuments implements HostDocumentStorage {
	private readonly accessed = new Map<string, string | undefined>()
	private readonly listeners = new Set<() => void>()
	private readonly observers = new Map<string, () => Promise<void>>()
	private readonly pending = new Set<Promise<unknown>>()
	private tail: Promise<void> = Promise.resolve()
	private closed = false

	constructor(
		private readonly directory: (requirement?: FsRequirement) => Promise<FsPromises>,
		readonly maxBytes: number,
		private readonly reportError: (error: unknown, key: string) => void,
	) {}

	getText(key: string): Promise<string | undefined> {
		this.assertKey(key)
		return this.track(
			this.read(key).then((text) => {
				this.accessed.set(key, text)
				this.observe(key)
				return text
			}),
		)
	}

	put(key: string, text: string): Promise<void> {
		this.assertKey(key)
		assertDocumentBudget(text, this.maxBytes)
		const task = this.tail.then(async (): Promise<void> => {
			await writeFileAtomic(await this.directory({ writable: true }), key, text)
			this.accessed.set(key, text)
			this.observe(key)
			return undefined
		})
		this.tail = task.catch(() => {})
		return this.track(task)
	}

	stat(key: string): Promise<object | undefined> {
		this.assertKey(key)
		if (!this.accessed.has(key)) this.accessed.set(key, undefined)
		this.observe(key)
		return this.track(
			(async () => {
				const fs = await this.directory()
				try {
					return await fs.stat(key)
				} catch (error) {
					if (missing(error)) return undefined
					throw error
				}
			})(),
		)
	}

	subscribe(listener: () => void): () => void {
		this.assertOpen()
		this.listeners.add(listener)
		for (const key of this.accessed.keys()) this.observe(key)
		return () => {
			this.listeners.delete(listener)
			if (this.listeners.size === 0) this.stopObserving()
		}
	}

	async close(): Promise<void> {
		this.closed = true
		this.listeners.clear()
		this.stopObserving()
		const results = await Promise.allSettled(this.pending)
		const errors = results.flatMap((result) =>
			result.status === 'rejected' ? [result.reason] : [],
		)
		if (errors.length > 0) throw new AggregateError(errors, 'Failed to drain filesystem documents')
	}

	private async read(key: string): Promise<string | undefined> {
		const fs = await this.directory()
		try {
			// Bound reads before allocating the document text as well as after a concurrent replacement.
			const stat = await fs.stat(key)
			if (stat.size > this.maxBytes)
				throw new RangeError(`[core.fs] document exceeds ${this.maxBytes} UTF-8 bytes`)
			const text = await fs.readFile(key, 'utf8')
			assertDocumentBudget(text, this.maxBytes)
			return text
		} catch (error) {
			if (missing(error)) return undefined
			throw error
		}
	}

	private observe(key: string): void {
		if (this.closed || this.listeners.size === 0 || this.observers.has(key)) return
		this.observers.set(
			key,
			observeFile(
				() => this.read(key),
				this.accessed.get(key),
				(text) => {
					this.accessed.set(key, text)
					for (const listener of this.listeners) {
						try {
							listener()
						} catch (error) {
							this.reportError(error, key)
						}
					}
				},
				(error) => this.reportError(error, key),
			),
		)
	}

	private stopObserving(): void {
		for (const stop of this.observers.values()) this.track(stop())
		this.observers.clear()
	}

	private track<T>(task: Promise<T>): Promise<T> {
		this.pending.add(task)
		void task.then(
			() => this.pending.delete(task),
			() => this.pending.delete(task),
		)
		return task
	}

	private assertKey(key: string): void {
		this.assertOpen()
		assertDocumentKey(key)
	}

	private assertOpen(): void {
		if (this.closed) throw withErrno('EBADF', 'Host documents are closed')
	}
}

function missing(error: unknown): boolean {
	return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}
