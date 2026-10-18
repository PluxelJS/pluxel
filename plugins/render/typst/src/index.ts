import { BasePlugin, Plugin } from '@pluxel/core'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { NodeModules, defineNodeModule } from '@pluxel/services/node'
import { Workers, defineWorkerTask } from '@pluxel/services/workers'
import { NativeCompilerClient } from './native-client.js'
import { resolveNativeBinding } from './native-binding.ts'
import { TypstConfig } from './config.ts'
import type { TypstTemplate } from './contracts.ts'
import { TypstError } from './errors.ts'
import { DocumentSession, type TypstSession } from './session.ts'
import { createTypstOperation, type TypstOperationOptions } from './operation.ts'
import type { TypstSvgOptions } from './svg.ts'
import type { TypstSvgWorkerInput, TypstSvgWorkerOutput } from './svg-worker.ts'
import { assertSourceBytes } from './resources.ts'

const compilerModule = defineNodeModule(import.meta.url, './worker.ts')
const svgTask = defineWorkerTask<TypstSvgWorkerInput, TypstSvgWorkerOutput>(
	import.meta.url,
	'./svg-worker.ts',
)

type Generation = {
	active: boolean
	controller: AbortController
	sessions: Set<DocumentSession>
	svg: Set<Promise<unknown>>
}

@Plugin()
export class TypstPlugin extends BasePlugin {
	private readonly config = this.configs.use(TypstConfig)
	private generation?: Generation
	private workerUrl?: URL
	private bindingPath?: string

	constructor(private readonly fonts: FontsPlugin) {
		super()
	}

	override async init(): Promise<void> {
		this.bindingPath = resolveNativeBinding(import.meta.url)
		const generation: Generation = {
			active: true,
			controller: new AbortController(),
			sessions: new Set(),
			svg: new Set(),
		}
		this.generation = generation
		this.ctx.effects.defer(
			async () => {
				generation.active = false
				generation.controller.abort(new TypstError('CLOSED', 'TypstPlugin generation stopped'))
				if (this.generation === generation) this.generation = undefined
				await Promise.allSettled(generation.svg)
				const results = await Promise.allSettled(
					[...generation.sessions].map((session) => session.dispose()),
				)
				const failed = results.filter((result) => result.status === 'rejected')
				if (failed.length > 0)
					throw new AggregateError(
						failed.map((result) => result.reason),
						'Typst sessions failed to close',
					)
			},
			{ tag: 'typst-generation' },
		)
		await this.ctx.require(NodeModules).use(compilerModule, (url) => {
			this.workerUrl = url
			return async () => {
				await Promise.all([...generation.sessions].map((session) => session.dispose()))
			}
		})
	}

	/** Trusted Typst source to caller-owned SVG bytes; no session is retained. Requires Workers. */
	async renderSvg(source: string, options: TypstSvgOptions = {}): Promise<Uint8Array> {
		const generation = this.generation
		if (!generation?.active) throw new TypstError('CLOSED', 'TypstPlugin is not running')
		if (typeof source !== 'string' || source.length === 0)
			throw new TypstError('INVALID_INPUT', 'renderSvg requires non-empty Typst source')
		if (source.length > this.config.maxInputBytes)
			throw new TypstError('LIMIT_EXCEEDED', 'Typst source exceeds the input byte limit')
		const controller = new AbortController()
		const operation = createTypstOperation(options, [
			generation.controller.signal,
			controller.signal,
		])
		let pending: Promise<TypstSvgWorkerOutput> | undefined
		let cleanup: { cancel(): void } | undefined
		try {
			const requestedOutputBytes =
				options.maxOutputBytes === undefined ? this.config.maxOutputBytes : options.maxOutputBytes
			if (!Number.isSafeInteger(requestedOutputBytes) || requestedOutputBytes <= 0)
				throw new TypstError('INVALID_INPUT', 'maxOutputBytes must be a positive safe integer')
			const maxOutputBytes = Math.min(requestedOutputBytes, this.config.maxOutputBytes)
			operation.signal.throwIfAborted()
			const owner = this.ctx.caller ?? this.ctx
			cleanup = owner.effects.defer(
				async () => {
					controller.abort(new TypstError('CLOSED', 'Typst SVG caller stopped'))
					await pending?.catch(() => {})
				},
				{ tag: 'typst-svg' },
			)
			pending = this.ctx.require(Workers).runPrepared(
				svgTask,
				async (signal) => {
					await assertSourceBytes(source, this.config.maxInputBytes, signal)
					return {
						source,
						bindingPath: this.bindingPath!,
						fonts: await this.readFonts(signal),
						maxOutputBytes,
					}
				},
				{ signal: operation.signal, inputOwnership: 'borrowed', settlement: 'execution' },
			)
			generation.svg.add(pending)
			const result = await pending
			operation.signal.throwIfAborted()
			if (result.ok === false)
				throw new TypstError(result.code, 'Typst SVG rendering failed', {
					diagnostics: result.diagnostics,
				})
			return result.data
		} finally {
			if (pending) generation.svg.delete(pending)
			cleanup?.cancel()
			operation.dispose()
		}
	}

	/** Initial template and fixed fonts; caller keeps source files stable until this settles. */
	async open(template: TypstTemplate, options: TypstOperationOptions = {}): Promise<TypstSession> {
		const generation = this.generation
		if (!generation?.active) throw new TypstError('CLOSED', 'TypstPlugin is not running')
		if (!template || typeof template !== 'object' || !options || typeof options !== 'object')
			throw new TypstError('INVALID_INPUT', 'open requires a template and operation options')
		if (generation.sessions.size >= this.config.maxSessions)
			throw new TypstError('BUSY', 'Typst session capacity is full')
		if (!this.workerUrl) throw new TypstError('CLOSED', 'Typst compiler module is unavailable')
		const client = new NativeCompilerClient(this.workerUrl, this.bindingPath!)
		const owner = this.ctx.caller ?? this.ctx
		let ownerCleanup: { cancel(): void } | undefined
		const session = new DocumentSession(
			Object.freeze({ ...this.config }),
			async (prepare, signal) => client.run(await prepare(signal), signal),
			() => {
				generation.sessions.delete(session)
				ownerCleanup?.cancel()
			},
			() => client.close(),
			(input, signal) => client.render(input, signal),
		)
		generation.sessions.add(session)
		try {
			ownerCleanup = owner.effects.defer(() => session.dispose(), { tag: 'typst-session' })
			await session.initialize(template, (signal) => this.readFonts(signal), options)
			if (!generation.active) throw new TypstError('CLOSED', 'Typst generation stopped during open')
			return session
		} catch (cause) {
			try {
				await session.dispose()
			} catch (cleanup) {
				throw new AggregateError([cause, cleanup], 'Typst open and cleanup failed', {
					cause: cleanup,
				})
			}
			throw cause
		}
	}

	private async readFonts(signal: AbortSignal): Promise<Uint8Array[]> {
		const snapshot = this.fonts.portableFonts
		const bytes = snapshot.fonts.reduce((sum, font) => sum + font.byteLength, 0)
		if (bytes > this.config.maxFontBytes || snapshot.fonts.length > this.config.maxFiles)
			throw new TypstError('LIMIT_EXCEEDED', 'Typst font snapshot exceeds configured limits')
		const fonts: Uint8Array[] = []
		for (const font of snapshot.fonts) {
			if (font.family)
				throw new TypstError(
					'INVALID_INPUT',
					'Typst fonts must use embedded family names; Canvas family aliases are not supported',
				)
			fonts.push(await this.fonts.readPortableFont(font.id, { signal }))
		}
		return fonts
	}
}

export { TypstConfig } from './config.ts'
export { TypstError } from './errors.ts'
export type { TypstPluginConfig } from './config.ts'
export type { ResourceSource, TypstFiles, TypstTemplate } from './contracts.ts'
export type { TypstDiagnostic, TypstErrorCode } from './errors.ts'
export type { TypstSession, TypstCompiled } from './session.ts'
export type { TypstOperationOptions } from './operation.ts'
export type { TypstSvgOptions } from './svg.ts'
export type {
	TypstPreview,
	TypstNavigation,
	TypstNavigationPoint,
	TypstOutlineItem,
	TypstPage,
} from './preview-contract.ts'

export type { TypstRegion, TypstRenderPageOptions, TypstPageImage } from './page-render.ts'
