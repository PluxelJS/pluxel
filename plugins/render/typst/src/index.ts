import { BasePlugin, Plugin } from '@pluxel/core'
import { FontsPlugin } from '@pluxel/fonts'
import { NodeModules, defineNodeModule } from '@pluxel/services/node'
import { NativeCompilerClient } from './native-client.js'
import { TypstConfig } from './config.ts'
import type { TypstTemplate } from './contracts.ts'
import { TypstError } from './errors.ts'
import { DocumentSession, type TypstOperationOptions, type TypstSession } from './session.ts'

const compilerModule = defineNodeModule(import.meta.url, './worker.ts')

type Generation = { active: boolean; sessions: Set<DocumentSession> }

@Plugin()
export class TypstPlugin extends BasePlugin {
	private readonly config = this.configs.use(TypstConfig)
	private generation?: Generation
	private workerUrl?: URL

	constructor(private readonly fonts: FontsPlugin) {
		super()
	}

	override async init(): Promise<void> {
		const generation: Generation = { active: true, sessions: new Set() }
		this.generation = generation
		this.ctx.effects.defer(
			async () => {
				generation.active = false
				if (this.generation === generation) this.generation = undefined
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

	/** Initial template and fixed fonts; caller keeps source files stable until this settles. */
	async open(template: TypstTemplate, options: TypstOperationOptions = {}): Promise<TypstSession> {
		const generation = this.generation
		if (!generation?.active) throw new TypstError('CLOSED', 'TypstPlugin is not running')
		if (!template || typeof template !== 'object' || !options || typeof options !== 'object')
			throw new TypstError('INVALID_INPUT', 'open requires a template and operation options')
		if (generation.sessions.size >= this.config.maxSessions)
			throw new TypstError('BUSY', 'Typst session capacity is full')
		if (!this.workerUrl) throw new TypstError('CLOSED', 'Typst compiler module is unavailable')
		const client = new NativeCompilerClient(this.workerUrl)
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
			await session.initialize(
				template,
				async (signal) => {
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
				},
				options,
			)
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
}

export { TypstConfig } from './config.ts'
export { TypstError } from './errors.ts'
export type { TypstPluginConfig } from './config.ts'
export type { ResourceSource, TypstFiles, TypstTemplate } from './contracts.ts'
export type { TypstDiagnostic, TypstErrorCode } from './errors.ts'
export type { TypstSession, TypstCompiled, TypstOperationOptions } from './session.ts'
export type {
	TypstPreview,
	TypstNavigation,
	TypstNavigationPoint,
	TypstOutlineItem,
	TypstPage,
} from './preview-contract.ts'

export type { TypstRegion, TypstRenderPageOptions, TypstPageImage } from './page-render.ts'
