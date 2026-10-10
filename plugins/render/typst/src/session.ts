import { randomUUID } from 'node:crypto'
import { WorkerTaskError } from '@pluxel/services/workers'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import type { TypstPluginConfig } from './config.ts'
import type { TypstFiles, TypstTemplate } from './contracts.ts'
import { TypstError, type TypstDiagnostic } from './errors.ts'
import type { TypstPreview } from './preview-contract.ts'
import { prepareInputs, prepareTemplate } from './resources.ts'
import type { TypstWorkerInput, TypstWorkerOutput } from './worker.ts'

export interface TypstOperationOptions {
	readonly signal?: AbortSignal
	/** Includes queue time. Omitted means no per-call deadline. */
	readonly timeoutMs?: number
}
export interface TypstCompiled {
	readonly revision: number
	readonly preview: TypstPreview
	readonly diagnostics: readonly TypstDiagnostic[]
}
export interface TypstSession extends AsyncDisposable {
	readonly id: string
	/** Full replacement; sources must stay unchanged until the Promise settles. */
	update(input: { readonly files: TypstFiles } & TypstOperationOptions): Promise<TypstCompiled>
	/** Returns a caller-owned copy of the PDF generated with this revision. */
	exportPdf(revision: number): Promise<Uint8Array>
	dispose(): Promise<void>
}

type TaskRunner = (
	prepare: (signal: AbortSignal) => Promise<TypstWorkerInput>,
	signal: AbortSignal,
) => Promise<TypstWorkerOutput>
type FontReader = (signal: AbortSignal) => Promise<readonly Uint8Array[]>
type Job = { run(): Promise<void>; cancel(): void }

export class DocumentSession implements TypstSession {
	readonly id = randomUUID()
	private readonly controller = new AbortController()
	private readonly queue: Job[] = []
	private readonly pending = new Set<Promise<unknown>>()
	private active = false
	private revision = 0
	private current?: { revision: number; pdf: Uint8Array }
	private directory?: string
	private entry = ''
	private fontPaths: string[] = []
	private closing?: Promise<void>
	private ready?: Promise<void>
	private cleanupFailure?: Error

	constructor(
		private readonly config: TypstPluginConfig,
		private readonly runTask: TaskRunner,
		private readonly released: () => void,
	) {}

	initialize(
		template: TypstTemplate,
		readFonts: FontReader,
		options: TypstOperationOptions,
	): Promise<void> {
		this.ready = this.prepare(template, readFonts, options)
		return this.ready
	}

	private async prepare(
		template: TypstTemplate,
		readFonts: FontReader,
		options: TypstOperationOptions,
	): Promise<void> {
		const operation = this.operation(options)
		try {
			operation.signal.throwIfAborted()
			this.directory = await mkdtemp(join(tmpdir(), 'pluxel-typst-'))
			const root = join(this.directory, 'workspace')
			await mkdir(root)
			const prepared = await prepareTemplate(
				template,
				root,
				{
					...this.resourceLimits,
					maxBytes: this.config.maxTemplateBytes,
				},
				operation.signal,
			)
			this.entry = prepared.entry
			const fonts = await readFonts(operation.signal)
			const fontFiles: Record<string, { kind: 'bytes'; bytes: Uint8Array }> = {}
			fonts.forEach((bytes, i) => {
				fontFiles[`/inputs/font-${i}.ttf`] = { kind: 'bytes', bytes }
			})
			const fontRoot = join(this.directory, 'fonts')
			await prepareInputs(
				fontFiles,
				fontRoot,
				{ ...this.resourceLimits, maxBytes: this.config.maxFontBytes },
				operation.signal,
			)
			this.fontPaths = [join(fontRoot, 'inputs')]
			operation.signal.throwIfAborted()
		} finally {
			operation.dispose()
		}
	}

	update(input: { readonly files: TypstFiles } & TypstOperationOptions): Promise<TypstCompiled> {
		try {
			this.assertOpen()
			if (!input || typeof input !== 'object')
				throw new TypstError('INVALID_INPUT', 'update requires a files object')
			if (this.queue.length >= this.config.maxQueuedUpdates)
				throw new TypstError('BUSY', 'Typst session update queue is full')
			const operation = this.operation(input)
			if (operation.signal.aborted) {
				operation.dispose()
				throw operation.signal.reason
			}
			let resolve!: (result: TypstCompiled) => void
			let reject!: (reason: unknown) => void
			const result = new Promise<TypstCompiled>((yes, no) => {
				resolve = yes
				reject = no
			})
			const job: Job = {
				run: async () => {
					operation.signal.removeEventListener('abort', job.cancel)
					try {
						resolve(await this.compile(input.files, operation.signal))
					} catch (cause) {
						reject(cause)
					} finally {
						operation.dispose()
					}
				},
				cancel: () => {
					const index = this.queue.indexOf(job)
					if (index < 0) return
					this.queue.splice(index, 1)
					operation.signal.removeEventListener('abort', job.cancel)
					operation.dispose()
					reject(operation.signal.reason)
				},
			}
			operation.signal.addEventListener('abort', job.cancel, { once: true })
			this.queue.push(job)
			this.track(result)
			this.drain()
			return result
		} catch (cause) {
			return Promise.reject(cause)
		}
	}

	private drain(): void {
		if (this.active) return
		const job = this.queue.shift()
		if (!job) return
		this.active = true
		void job.run().finally(() => {
			this.active = false
			this.drain()
		})
	}

	private async compile(files: TypstFiles, signal: AbortSignal): Promise<TypstCompiled> {
		await this.ready
		this.assertOpen()
		signal.throwIfAborted()
		const root = join(this.directory!, 'workspace')
		let staging: string | undefined
		try {
			const output = await this.runTask(async (workerSignal) => {
				const preparationSignal = AbortSignal.any([signal, workerSignal])
				preparationSignal.throwIfAborted()
				staging = await mkdtemp(join(this.directory!, 'update-'))
				await prepareInputs(files, staging, this.resourceLimits, preparationSignal)
				preparationSignal.throwIfAborted()
				await rm(join(root, 'inputs'), { recursive: true, force: true })
				await rename(join(staging, 'inputs'), join(root, 'inputs'))
				return {
					root,
					entry: this.entry,
					fontPaths: this.fontPaths,
					maxOutputBytes: this.config.maxOutputBytes,
				}
			}, signal)
			signal.throwIfAborted()
			this.assertOpen()
			if (!output.ok)
				throw new TypstError(
					output.code,
					output.code === 'COMPILE_FAILED'
						? 'Typst compilation failed'
						: 'Typst output exceeds configured limit',
					{ diagnostics: output.diagnostics },
				)
			const revision = ++this.revision
			this.current = { revision, pdf: output.pdf }
			return {
				revision,
				preview: {
					sessionId: this.id,
					revision,
					format: 'vector',
					compilerVersion: '0.7.0',
					data: output.vector,
				},
				diagnostics: output.diagnostics,
			}
		} catch (cause) {
			if (cause instanceof WorkerTaskError && cause.code === 'EXECUTION_UNSETTLED') {
				this.cleanupFailure = new Error(
					`Typst worker exit is unconfirmed; resources retained at ${this.directory}`,
					{ cause },
				)
				this.controller.abort(this.cleanupFailure)
			}
			throw cause
		} finally {
			if (staging && !this.cleanupFailure) await rm(staging, { recursive: true, force: true })
		}
	}

	exportPdf(revision: number): Promise<Uint8Array> {
		try {
			this.assertOpen()
			if (!this.current || revision !== this.current.revision)
				throw new TypstError('STALE_REVISION', 'Requested Typst revision is no longer available')
			const pdf = this.current.pdf
			return this.track(copyBytes(pdf, this.controller.signal))
		} catch (cause) {
			return Promise.reject(cause)
		}
	}

	dispose(): Promise<void> {
		if (this.closing) return this.closing
		this.controller.abort(new TypstError('CLOSED', 'Typst session is closed'))
		this.closing = (async () => {
			try {
				await Promise.allSettled([...(this.ready ? [this.ready] : []), ...this.pending])
				this.current = undefined
				if (this.cleanupFailure) throw this.cleanupFailure
				if (this.directory) await rm(this.directory, { recursive: true, force: true })
			} finally {
				this.released()
			}
		})()
		return this.closing
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose()
	}

	private assertOpen(): void {
		if (this.controller.signal.aborted) throw new TypstError('CLOSED', 'Typst session is closed')
	}
	private get resourceLimits() {
		return {
			maxFiles: this.config.maxFiles,
			maxBytes: this.config.maxInputBytes,
			maxJsonDepth: this.config.maxJsonDepth,
			maxJsonValues: this.config.maxJsonValues,
		}
	}
	private track<T>(promise: Promise<T>): Promise<T> {
		this.pending.add(promise)
		void promise.then(
			() => this.pending.delete(promise),
			() => this.pending.delete(promise),
		)
		return promise
	}
	private operation(options: TypstOperationOptions) {
		if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
			throw new TypstError('INVALID_INPUT', 'signal must be an AbortSignal')
		if (
			options.timeoutMs !== undefined &&
			(!Number.isSafeInteger(options.timeoutMs) ||
				options.timeoutMs <= 0 ||
				options.timeoutMs > 2_147_483_647)
		)
			throw new TypstError(
				'INVALID_INPUT',
				'timeoutMs must be a positive integer at most 2147483647',
			)
		const timeout = new AbortController()
		const timer =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(
						() => timeout.abort(new DOMException('Typst operation timed out', 'TimeoutError')),
						options.timeoutMs,
					)
		const signal = AbortSignal.any([
			this.controller.signal,
			timeout.signal,
			...(options.signal ? [options.signal] : []),
		])
		return {
			signal,
			dispose: () => {
				if (timer) clearTimeout(timer)
			},
		}
	}
}

async function copyBytes(source: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
	const result = new Uint8Array(source.byteLength)
	for (let offset = 0; offset < source.length; offset += 64 * 1024) {
		signal.throwIfAborted()
		result.set(source.subarray(offset, offset + 64 * 1024), offset)
		await setImmediate()
	}
	signal.throwIfAborted()
	return result
}
