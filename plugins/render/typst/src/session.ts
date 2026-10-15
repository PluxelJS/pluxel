import { randomUUID } from 'node:crypto'
import { WorkerTaskError } from '@pluxel/services/workers'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import type { TypstPluginConfig } from './config.ts'
import type { TypstFiles, TypstTemplate } from './contracts.ts'
import { TypstError, type TypstDiagnostic } from './errors.ts'
import {
	validateRenderPage,
	type TypstRenderPageOptions,
	type TypstPageImage,
} from './page-render.ts'
import type { TypstPreview } from './preview-contract.ts'
import { createTypstOperation, type TypstOperationOptions } from './operation.ts'
import { prepareInputs, prepareTemplate } from './resources.ts'
import type { TypstWorkerInput, TypstWorkerOutput, TypstRenderWorkerInput } from './worker.ts'

export interface TypstCompiled {
	readonly revision: number
	readonly preview: TypstPreview
	readonly diagnostics: readonly TypstDiagnostic[]
}
export interface TypstSession extends AsyncDisposable {
	readonly id: string
	/** Full input replacement and optional full template replacement; sources stay unchanged until settlement. Fonts remain fixed. */
	update(
		input: {
			readonly files: TypstFiles
			readonly template?: TypstTemplate
		} & TypstOperationOptions,
	): Promise<TypstCompiled>
	/** Renders the retained revision, serialized with updates; never recompiles. */
	renderPage(input: TypstRenderPageOptions & TypstOperationOptions): Promise<TypstPageImage>
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
		private readonly closeNative: () => Promise<void> = async () => {},
		private readonly renderNative?: (
			input: TypstRenderWorkerInput,
			signal: AbortSignal,
		) => Promise<TypstPageImage>,
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

	update(
		input: {
			readonly files: TypstFiles
			readonly template?: TypstTemplate
		} & TypstOperationOptions,
	): Promise<TypstCompiled> {
		if (!input || typeof input !== 'object')
			return Promise.reject(new TypstError('INVALID_INPUT', 'update requires a files object'))
		return this.enqueue(input, (signal) => this.compile(input.files, signal, input.template))
	}

	renderPage(input: TypstRenderPageOptions & TypstOperationOptions): Promise<TypstPageImage> {
		try {
			validateRenderPage(input)
		} catch (cause) {
			return Promise.reject(cause)
		}
		return this.enqueue(input, async (signal) => {
			await this.ready
			this.assertOpen()
			signal.throwIfAborted()
			if (!this.current || input.revision !== this.current.revision)
				throw new TypstError('STALE_REVISION', 'Requested Typst revision is no longer available')
			if (!this.renderNative) throw new Error('Native page renderer is unavailable')
			try {
				const result = await this.renderNative(
					{
						kind: 'render',
						revision: input.revision,
						page: input.page,
						scale: input.scale,
						region: input.region,
						maxOutputBytes: this.config.maxOutputBytes,
					},
					signal,
				)
				signal.throwIfAborted()
				this.assertOpen()
				return result
			} catch (cause) {
				this.handleNativeFailure(cause, signal)
				throw cause
			}
		})
	}

	private enqueue<T>(
		input: TypstOperationOptions,
		execute: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		try {
			this.assertOpen()
			if (this.queue.length >= this.config.maxQueuedUpdates)
				throw new TypstError('BUSY', 'Typst session operation queue is full')
			const operation = this.operation(input)
			if (operation.signal.aborted) {
				operation.dispose()
				throw operation.signal.reason
			}
			let resolve!: (result: T) => void
			let reject!: (reason: unknown) => void
			const result = new Promise<T>((yes, no) => {
				resolve = yes
				reject = no
			})
			const job: Job = {
				run: async () => {
					operation.signal.removeEventListener('abort', job.cancel)
					try {
						resolve(await execute(operation.signal))
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

	private async compile(
		files: TypstFiles,
		signal: AbortSignal,
		template?: TypstTemplate,
	): Promise<TypstCompiled> {
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
				if (template) {
					const replacement = join(staging, 'template')
					const prepared = await prepareTemplate(
						template,
						replacement,
						{ ...this.resourceLimits, maxBytes: this.config.maxTemplateBytes },
						preparationSignal,
					)
					preparationSignal.throwIfAborted()
					await rm(root, { recursive: true, force: true })
					await rename(replacement, root)
					this.entry = prepared.entry
				}
				preparationSignal.throwIfAborted()
				await rm(join(root, 'inputs'), { recursive: true, force: true })
				await rename(join(staging, 'inputs'), join(root, 'inputs'))
				return {
					root,
					revision: this.revision + 1,
					entry: this.entry,
					fontPaths: this.fontPaths,
					maxOutputBytes: this.config.maxOutputBytes,
				}
			}, signal)
			signal.throwIfAborted()
			this.assertOpen()
			if (output.ok === false)
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
					navigation: output.navigation,
				},
				diagnostics: output.diagnostics,
			}
		} catch (cause) {
			this.handleNativeFailure(cause, signal)
			throw cause
		} finally {
			if (staging && !this.cleanupFailure) await rm(staging, { recursive: true, force: true })
		}
	}

	private handleNativeFailure(cause: unknown, signal: AbortSignal): void {
		if (signal.aborted) this.controller.abort(signal.reason)
		if (cause instanceof WorkerTaskError && cause.code === 'EXECUTION_UNSETTLED') {
			this.cleanupFailure = new Error(
				`Typst worker exit is unconfirmed; resources retained at ${this.directory}`,
				{ cause },
			)
			this.controller.abort(this.cleanupFailure)
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
				await this.closeNative()
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
		return createTypstOperation(options, [this.controller.signal])
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
