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
	constructor(
		private readonly url: URL,
		private readonly bindingPath: string,
	) {}
	get closed(): boolean {
		return this.closing !== undefined || this.failure !== undefined
	}
	compile(input: TypstWorkerInput, signal: AbortSignal): Promise<TypstWorkerOutput> {
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
		if (this.closed) throw this.failure ?? new TypstError('CLOSED', 'Typst compiler is closed')
		if (this.pending) throw new Error('Typst compiler already has an active update')
		if (!this.worker) {
			const worker = (this.worker = new Worker(this.url))
			worker.on(
				'message',
				(message: { ok: boolean; value?: unknown; error?: Error; code?: TypstErrorCode }) => {
					if (this.closing) return
					const pending = this.pending
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
			worker.on('error', (error) => this.fail(error))
			worker.on('messageerror', (error) => this.fail(error))
			worker.on('exit', (code) => {
				this.fail(new Error(`Typst compiler thread exited (${code})`))
			})
		}
		const pending = Promise.withResolvers<unknown>()
		this.pending = pending
		const abort = () => {
			void this.close().then(() => pending.reject(signal.reason), pending.reject)
		}
		signal.addEventListener('abort', abort, { once: true })
		try {
			this.worker.postMessage({ ...input, bindingPath: this.bindingPath }, [])
			const value = await pending.promise
			if (signal.aborted) {
				await this.close()
				signal.throwIfAborted()
			}
			return value as T
		} catch (cause) {
			if (this.failure) {
				try {
					await this.close()
				} catch (cleanup) {
					throw new WorkerTaskError(
						'EXECUTION_UNSETTLED',
						'Typst compiler thread exit is unconfirmed',
						{
							cause: new AggregateError(
								[cause, cleanup],
								'Typst compiler execution and cleanup failed',
								{ cause },
							),
						},
					)
				}
			}
			throw cause
		} finally {
			this.pending = undefined
			signal.removeEventListener('abort', abort)
		}
	}
	private fail(error: unknown): void {
		if (this.closing || this.failure) return
		this.failure =
			error instanceof Error ? error : new Error('Typst compiler failed', { cause: error })
		this.pending?.reject(this.failure)
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
