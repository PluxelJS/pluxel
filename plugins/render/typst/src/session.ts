import { randomUUID } from 'node:crypto'
import { WorkerTaskError } from '@pluxel/services/workers'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import type { TypstPluginConfig } from './config.ts'
import type { TypstFiles, TypstTemplate } from './contracts.ts'
import { TypstError, type TypstDiagnostic } from './errors.ts'
import type { NativeCompilerClient } from './native-client.ts'
import {
	validateRenderPage,
	type TypstRenderPageOptions,
	type TypstPageImage,
} from './page-render.ts'
import type { TypstPreview } from './preview-contract.ts'
import { createTypstOperation, type TypstOperationOptions } from './operation.ts'
import { prepareInputs, prepareTemplate } from './resources.ts'
import type { TypstWorkerOutput } from './worker.ts'

export interface TypstCompiled {
	readonly revision: number
	readonly preview: TypstPreview
	readonly diagnostics: readonly TypstDiagnostic[]
}
export interface TypstSession extends AsyncDisposable {
	readonly id: string
	/** Compiles a complete input set and adopts a replacement template on success. Borrowed sources stay unchanged until settlement. */
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

type FontReader = (signal: AbortSignal) => Promise<readonly Uint8Array[]>
type Job = { run(): Promise<void>; cancel(): void }
type Compiler = Pick<NativeCompilerClient, 'compile' | 'render' | 'close' | 'closed'>
type Workspace = {
	root: string
	template: { root: string; entry: string }
	fontPaths: string[]
}

export class DocumentSession implements TypstSession {
	readonly id = randomUUID()
	private readonly controller = new AbortController()
	private readonly signal: AbortSignal
	private readonly queue: Job[] = []
	private readonly pending = new Set<Promise<unknown>>()
	private active = false
	private current?: { revision: number; pdf: Uint8Array }
	private directory?: string
	private closing?: Promise<void>
	private ready?: Promise<Workspace>
	private unsettled?: WorkerTaskError

	constructor(
		private readonly config: TypstPluginConfig,
		private readonly compiler: Compiler,
		private readonly released: () => void,
		providerSignal?: AbortSignal,
	) {
		this.signal = providerSignal
			? AbortSignal.any([providerSignal, this.controller.signal])
			: this.controller.signal
	}

	async initialize(
		template: TypstTemplate,
		readFonts: FontReader,
		options: TypstOperationOptions,
	): Promise<void> {
		if (this.ready) throw new Error('Typst session is already initializing or initialized')
		this.ready = this.prepare(template, readFonts, options)
		await this.ready
	}

	private async prepare(
		template: TypstTemplate,
		readFonts: FontReader,
		options: TypstOperationOptions,
	): Promise<Workspace> {
		const operation = this.operation(options)
		try {
			operation.signal.throwIfAborted()
			this.directory = await mkdtemp(join(tmpdir(), 'pluxel-typst-'))
			const root = join(this.directory, 'workspace')
			await mkdir(root)
			const templateRoot = join(this.directory, 'template')
			const { entry } = await prepareTemplate(
				template,
				templateRoot,
				{
					...this.resourceLimits,
					maxBytes: this.config.maxTemplateBytes,
				},
				operation.signal,
			)
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
			operation.signal.throwIfAborted()
			return {
				root,
				template: { root: templateRoot, entry },
				fontPaths: [join(fontRoot, 'inputs')],
			}
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
		return this.enqueue(input, (signal) => {
			signal.throwIfAborted()
			if (!this.current || input.revision !== this.current.revision)
				throw new TypstError('STALE_REVISION', 'Requested Typst revision is no longer available')
			return this.execute(
				() =>
					this.compiler.render(
						{
							kind: 'render',
							revision: input.revision,
							page: input.page,
							scale: input.scale,
							region: input.region,
							maxOutputBytes: this.config.maxOutputBytes,
						},
						signal,
					),
				signal,
			)
		})
	}

	private enqueue<T>(
		input: TypstOperationOptions,
		execute: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		try {
			this.assertOpen()
			if (this.queue.length >= this.config.maxQueuedOperations)
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
		const workspace = await this.ready!
		this.assertOpen()
		signal.throwIfAborted()
		const revision = (this.current?.revision ?? 0) + 1
		const staging = await mkdtemp(join(this.directory!, 'update-'))
		let candidateRoot: string | undefined
		let nextTemplate = workspace.template
		let output: Extract<TypstWorkerOutput, { ok: true }>
		try {
			await prepareInputs(files, staging, this.resourceLimits, signal)
			if (template !== undefined) {
				candidateRoot = await mkdtemp(join(this.directory!, 'template-'))
				const { entry } = await prepareTemplate(
					template,
					candidateRoot,
					{ ...this.resourceLimits, maxBytes: this.config.maxTemplateBytes },
					signal,
				)
				nextTemplate = { root: candidateRoot, entry }
			}
			const result = await this.execute(
				() =>
					this.compiler.compile(
						{
							root: workspace.root,
							templateRoot: nextTemplate.root,
							inputsRoot: join(staging, 'inputs'),
							revision,
							entry: nextTemplate.entry,
							fontPaths: workspace.fontPaths,
							maxOutputBytes: this.config.maxOutputBytes,
						},
						signal,
					),
				signal,
			)
			if (result.ok === false)
				throw new TypstError(
					result.code,
					result.code === 'COMPILE_FAILED'
						? 'Typst compilation failed'
						: 'Typst output exceeds configured limit',
					{ diagnostics: result.diagnostics },
				)
			output = result
		} catch (cause) {
			await this.discard(staging, candidateRoot, { cause })
			throw cause
		}
		await this.discard(staging, candidateRoot === undefined ? undefined : workspace.template.root)
		this.assertOpen()
		workspace.template = nextTemplate
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
	}

	private async execute<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
		signal.throwIfAborted()
		try {
			return await run()
		} catch (cause) {
			if (cause instanceof WorkerTaskError && cause.code === 'EXECUTION_UNSETTLED')
				this.retainUnsettled(cause)
			if (this.unsettled || this.compiler.closed) this.controller.abort(this.unsettled ?? cause)
			throw cause
		}
	}

	private retainUnsettled(cause: unknown): WorkerTaskError {
		return (this.unsettled ??= new WorkerTaskError(
			'EXECUTION_UNSETTLED',
			`Typst worker exit is unconfirmed; resources retained at ${this.directory}`,
			{ cause },
		))
	}

	private async discard(staging: string, template?: string, failure?: { cause: unknown }) {
		if (this.unsettled) return
		try {
			await rm(staging, { recursive: true, force: true })
			if (template !== undefined) await rm(template, { recursive: true, force: true })
		} catch (cleanup) {
			this.controller.abort(cleanup)
			throw failure
				? new AggregateError([failure.cause, cleanup], 'Typst update and cleanup failed', failure)
				: cleanup
		}
	}

	exportPdf(revision: number): Promise<Uint8Array> {
		try {
			this.assertOpen()
			if (!this.current || revision !== this.current.revision)
				throw new TypstError('STALE_REVISION', 'Requested Typst revision is no longer available')
			const pdf = this.current.pdf
			return this.track(copyBytes(pdf, this.signal))
		} catch (cause) {
			return Promise.reject(cause)
		}
	}

	dispose(): Promise<void> {
		if (this.closing) return this.closing
		this.controller.abort(new TypstError('CLOSED', 'Typst session is closed'))
		this.closing = (async () => {
			await Promise.allSettled([...(this.ready ? [this.ready] : []), ...this.pending])
			this.current = undefined
			if (this.unsettled) throw this.unsettled
			try {
				await this.compiler.close()
			} catch (cause) {
				throw this.retainUnsettled(cause)
			}
			try {
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
		if (this.signal.aborted) throw new TypstError('CLOSED', 'Typst session is closed')
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
		return createTypstOperation(options, [this.signal])
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
