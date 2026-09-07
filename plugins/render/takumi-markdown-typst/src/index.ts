import {
	BasePlugin,
	defineWorkerTask,
	Plugin,
	WorkerTaskError,
	type WorkerRunOptions,
	type WorkerTaskDeclaration,
} from '@pluxel/runtime'
import {
	TakumiMarkdownPlugin,
	type MarkdownExtension,
	type MarkdownExtensionContext,
} from '@pluxel/takumi-markdown'
import { createTypstMathLimits, TypstMathConfig, type TypstMathLimits } from './config.ts'
import { TypstMathError } from './errors.ts'
import { validateTypstMathFormula } from './formula.ts'
import type { TypstMathWorkerInput, TypstMathWorkerOutput } from './worker.ts'

const typstMathTask = defineWorkerTask<TypstMathWorkerInput, TypstMathWorkerOutput>(
	import.meta.url,
	'./worker.ts',
)

type WorkerRunner = Readonly<{
	run<Input, Output>(
		declaration: WorkerTaskDeclaration<Input, Output>,
		input: Input,
		options?: WorkerRunOptions,
	): Promise<Output>
}>

type TypstGeneration = Readonly<{
	controller: AbortController
	extensions: Set<TypstExtensionState>
	limits: TypstMathLimits
}>

type TypstExtensionState = {
	active: boolean
	readonly controller: AbortController
	readonly generation: TypstGeneration
	readonly pending: Set<Promise<unknown>>
	readonly workers: WorkerRunner
}

@Plugin()
export class TypstMathPlugin extends BasePlugin {
	private readonly config = this.configs.use(TypstMathConfig)
	private generation?: TypstGeneration

	constructor(private readonly markdown: TakumiMarkdownPlugin) {
		super()
	}

	override init(): void {
		const generation: TypstGeneration = Object.freeze({
			controller: new AbortController(),
			extensions: new Set<TypstExtensionState>(),
			limits: createTypstMathLimits(this.config),
		})
		this.generation = generation
		this.ctx.effects.defer(
			async () => {
				if (this.generation === generation) this.generation = undefined
				const reason = new TypstMathError(
					'NOT_RUNNING',
					'Typst math capability belongs to a stopped plugin generation',
				)
				generation.controller.abort(reason)
				await Promise.allSettled(
					[...generation.extensions].map((extension) => this.closeExtension(extension, reason)),
				)
			},
			{ tag: 'takumi-markdown-typst-generation' },
		)
	}

	/**
	 * Returns a trusted Markdown extension that turns restricted inline/display math into SVG assets.
	 * It deliberately does not expose a general Typst document compiler.
	 */
	createMarkdownExtension(): MarkdownExtension {
		const generation = this.requireGeneration()
		const state: TypstExtensionState = {
			active: true,
			controller: new AbortController(),
			generation,
			pending: new Set(),
			workers: this.ctx.workers as WorkerRunner,
		}
		generation.extensions.add(state)
		const owner = this.ctx.caller ?? this.ctx
		try {
			owner.effects.defer(
				() =>
					this.closeExtension(
						state,
						new TypstMathError(
							'NOT_RUNNING',
							'Typst math extension belongs to a stopped caller generation',
						),
					),
				{ tag: 'takumi-markdown-typst-extension' },
			)
		} catch (cause) {
			void this.closeExtension(
				state,
				new TypstMathError('NOT_RUNNING', 'Typst math extension caller is stopped', { cause }),
			)
			throw new TypstMathError('NOT_RUNNING', 'Typst math extension caller is stopped', { cause })
		}
		return Object.freeze({
			name: 'typst-math',
			requiredFeatures: Object.freeze({ math: true }),
			create: (context) => this.createPipeline(state, context),
		})
	}

	private createPipeline(
		state: TypstExtensionState,
		context: MarkdownExtensionContext,
	): ReturnType<MarkdownExtension['create']> {
		this.assertExtensionActive(state)
		let formulas = 0
		let totalSvgBytes = 0
		const compile = async (formula: unknown): Promise<string> => {
			formulas += 1
			if (formulas > state.generation.limits.maxFormulas) {
				throw new TypstMathError(
					'FORMULA_TOO_LARGE',
					'Typst math exceeds the configured formula-count limit',
				)
			}
			const source = validateTypstMathFormula(formula, state.generation.limits.maxFormulaCharacters)
			const svg = await this.trackExtension(state, this.compileFormula(state, source, context))
			if (svg.byteLength > state.generation.limits.maxTotalSvgBytes - totalSvgBytes) {
				throw new TypstMathError(
					'SVG_TOO_LARGE',
					'Typst math SVGs exceed the configured total byte limit',
				)
			}
			totalSvgBytes += svg.byteLength
			return await context.assets.add({ data: svg, mediaType: 'image/svg+xml' })
		}
		return Object.freeze({
			mdast: [
				{
					name: 'pluxel-typst-math',
					inlineMath: async (node, visitor) => {
						const source = await compile(node.value)
						visitor.replaceNode(node, {
							type: 'image',
							alt: 'math',
							url: source,
						})
					},
					math: async (node, visitor) => {
						const source = await compile(node.value)
						visitor.replaceNode(node, {
							type: 'paragraph',
							children: [{ type: 'image', alt: 'math', url: source }],
						})
					},
				},
			],
		})
	}

	private async compileFormula(
		state: TypstExtensionState,
		formula: string,
		context: MarkdownExtensionContext,
	): Promise<Uint8Array> {
		this.assertExtensionActive(state)
		const abortLink = linkAbortSignals([
			state.generation.controller.signal,
			state.controller.signal,
			context.signal,
		])
		try {
			abortLink.signal.throwIfAborted()
			const response = await state.workers.run(
				typstMathTask,
				{
					formula,
					maxFormulaCharacters: state.generation.limits.maxFormulaCharacters,
					maxSvgBytes: state.generation.limits.maxSvgBytes,
				},
				{ signal: abortLink.signal, inputOwnership: 'borrowed' },
			)
			if (response.ok === false) {
				throw new TypstMathError(response.error.code, response.error.message)
			}
			return response.svg
		} catch (cause) {
			if (cause instanceof TypstMathError || cause instanceof WorkerTaskError) throw cause
			if (abortLink.signal.aborted) throw abortReason(abortLink.signal)
			throw new TypstMathError('FORMULA_COMPILE_FAILED', 'Typst math worker failed', { cause })
		} finally {
			abortLink.dispose()
		}
	}

	private trackExtension<T>(state: TypstExtensionState, operation: Promise<T>): Promise<T> {
		state.pending.add(operation)
		void operation.then(
			() => state.pending.delete(operation),
			() => state.pending.delete(operation),
		)
		return operation
	}

	private async closeExtension(
		state: TypstExtensionState,
		reason = new TypstMathError('NOT_RUNNING', 'Typst math extension was closed'),
	): Promise<void> {
		if (!state.active) {
			await Promise.allSettled(state.pending)
			return
		}
		state.active = false
		state.generation.extensions.delete(state)
		state.controller.abort(reason)
		await Promise.allSettled(state.pending)
	}

	private requireGeneration(): TypstGeneration {
		const generation = this.generation
		if (!generation || generation.controller.signal.aborted) {
			throw new TypstMathError('NOT_RUNNING', 'TypstMathPlugin is not running')
		}
		return generation
	}

	private assertExtensionActive(state: TypstExtensionState): void {
		if (!state.active || state.generation.controller.signal.aborted) {
			throw new TypstMathError(
				'NOT_RUNNING',
				'Typst math extension is closed or belongs to a stopped generation',
			)
		}
	}
}

function linkAbortSignals(signals: readonly (AbortSignal | undefined)[]): Readonly<{
	signal: AbortSignal
	dispose(): void
}> {
	const controller = new AbortController()
	const listeners: Array<Readonly<{ signal: AbortSignal; listener: () => void }>> = []
	for (const signal of signals) {
		if (!signal) continue
		if (signal.aborted) {
			controller.abort(signal.reason)
			break
		}
		const listener = () => controller.abort(signal.reason)
		signal.addEventListener('abort', listener, { once: true })
		listeners.push({ signal, listener })
	}
	return Object.freeze({
		signal: controller.signal,
		dispose() {
			for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener)
		},
	})
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException('Typst math compilation aborted', 'AbortError')
}

export { TypstMathConfig, TypstMathError }
export type { TypstMathErrorCode } from './errors.ts'
export type { TypstMathLimits, TypstMathPluginConfig } from './config.ts'
