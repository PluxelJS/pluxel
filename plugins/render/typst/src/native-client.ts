import { WorkerTaskError } from '@pluxel/services/workers'
import { Worker } from 'node:worker_threads'
import { TypstError, type TypstErrorCode } from './errors.ts'
import type { TypstPageImage } from './page-render.ts'
import type { TypstWorkerInput, TypstWorkerOutput, TypstRenderWorkerInput } from './worker.js'

/** A session owns one native compiler thread; cancellation waits for thread exit. */
export class NativeCompilerClient {
	private worker?: Worker
	private closing?: Promise<void>
	private failure?: Error
	private pending?: { resolve(value: unknown): void; reject(reason: unknown): void }
	constructor(private readonly url: URL) {}
	run(input: TypstWorkerInput, signal: AbortSignal): Promise<TypstWorkerOutput> {
		return this.request(input, signal)
	}
	render(input: TypstRenderWorkerInput, signal: AbortSignal): Promise<TypstPageImage> {
		return this.request(input, signal)
	}
	private async request<T>(
		input: TypstWorkerInput | TypstRenderWorkerInput,
		signal: AbortSignal,
	): Promise<T> {
		signal.throwIfAborted()
		if (this.closing || this.failure) throw this.failure ?? new Error('Typst compiler is closed')
		if (this.pending) throw new Error('Typst compiler already has an active update')
		if (!this.worker) {
			const worker = (this.worker = new Worker(this.url))
			worker.on(
				'message',
				(message: { ok: boolean; value?: unknown; error?: Error; code?: TypstErrorCode }) => {
					const pending = this.pending
					this.pending = undefined
					if (message.ok) pending?.resolve(message.value!)
					else
						pending?.reject(
							message.code
								? new TypstError(message.code, message.error?.message ?? 'Typst worker failed', {
										cause: message.error,
									})
								: (message.error ?? new Error('Typst worker failed')),
						)
				},
			)
			worker.on('error', (error) => {
				this.failure = error instanceof Error ? error : new Error(String(error))
				this.pending?.reject(error)
				this.pending = undefined
			})
			worker.on('exit', (code) => {
				if (!this.closing) this.failure = new Error(`Typst compiler thread exited (${code})`)
				this.pending?.reject(this.failure ?? new Error('Typst compiler closed'))
				this.pending = undefined
			})
		}
		let abort!: () => void
		try {
			return await new Promise<T>((resolve, reject) => {
				this.pending = { resolve: (value) => resolve(value as T), reject }
				abort = () => {
					this.failure =
						signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))
					void this.close().then(() => reject(signal.reason), reject)
				}
				signal.addEventListener('abort', abort, { once: true })
				try {
					this.worker!.postMessage(input, [])
				} catch (error) {
					this.pending = undefined
					reject(error)
				}
			})
		} finally {
			signal.removeEventListener('abort', abort)
			if (signal.aborted) await this.close()
		}
	}
	close(): Promise<void> {
		if (!this.closing)
			this.closing = (async () => {
				try {
					await this.worker?.terminate()
				} catch (cause) {
					throw new WorkerTaskError(
						'EXECUTION_UNSETTLED',
						'Typst compiler thread exit is unconfirmed',
						{ cause },
					)
				}
				this.worker = undefined
			})()
		return this.closing
	}
}
