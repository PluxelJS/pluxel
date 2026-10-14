import { BasePlugin, Plugin } from '@pluxel/core'
import { PlaywrightPlugin } from '@pluxel/playwright'
import { Vault } from '@pluxel/services/vault'
import type { BrowserContext } from 'playwright-core'
import * as v from 'valibot'
import { InvoiceConfig, InvoiceCredentialSchema } from './config.ts'
import {
	InvoiceError,
	type InvoiceExtraction,
	type InvoiceImage,
	type InvoiceImageResult,
	type InvoiceInput,
	type InvoiceOptions,
	type InvoiceVerification,
} from './contracts.ts'
import { queryFiscalPortal } from './fiscal-portal.ts'
import { abortable } from './operation.ts'
import { copyImage, extraction, validateInput } from './input.ts'
import { queryTaxPortal } from './tax-portal.ts'
import { complete, EXTRACTION_PROMPT } from './vlm.ts'

export { InvoiceConfig, InvoiceVaultSchema } from './config.ts'
export {
	type FiscalTicketInput,
	type InvoiceDetails,
	type InvoiceEvidence,
	type InvoiceParty,
	type InvoiceLineItem,
	type InvoiceDetailIssue,
	InvoiceError,
	type InvoiceExtraction,
	type InvoiceImage,
	type InvoiceImageResult,
	type InvoiceInput,
	type InvoiceOptions,
	type InvoiceVerification,
} from './contracts.ts'

type Generation = { active: boolean; calls: Map<AbortController, Promise<unknown>> }

/** Image transcription and platform-specific queries; no model decides authenticity. */
@Plugin({ displayName: 'Invoice extraction and verification', forkable: true })
export class InvoicePlugin extends BasePlugin {
	private readonly config = this.configs.use(InvoiceConfig)
	private generation: Generation | undefined = undefined
	private apiKey: string | undefined = undefined

	constructor(private readonly playwright: PlaywrightPlugin) {
		super()
	}

	protected override async init() {
		const generation: Generation = { active: true, calls: new Map() }
		this.generation = generation
		this.ctx.effects.defer(
			async () => {
				generation.active = false
				for (const controller of generation.calls.keys())
					controller.abort(new InvoiceError('NOT_RUNNING', 'Invoice plugin stopped'))
				await Promise.allSettled(generation.calls.values())
				this.apiKey = undefined
				if (this.generation === generation) this.generation = undefined
			},
			{ tag: 'invoice-operations', phase: 'shutdown' },
		)
		if (this.config.vlm) {
			const record = await this.ctx.require(Vault).kv().get(this.config.vlm.credentialKey)
			const parsed = v.safeParse(InvoiceCredentialSchema, record.value)
			if (!record.exists || !parsed.success)
				throw new Error('Invoice Vault credential is missing or invalid')
			this.apiKey = parsed.output.apiKey
		}
	}

	/** Extract only. No website submission; invalid model fields are returned for review. */
	async extract(
		image: InvoiceImage,
		options: Pick<InvoiceOptions, 'signal'> = {},
	): Promise<InvoiceExtraction> {
		const snapshot = copyImage(image)
		return await this.operation(options, (signal) => this.extractImage(snapshot, signal))
	}

	async verify(input: InvoiceInput, options: InvoiceOptions = {}): Promise<InvoiceVerification> {
		const snapshot = validateInput(input)
		const callbacks = { onChallenge: options?.onChallenge, onCaptcha: options?.onCaptcha }
		return await this.operation(options, (signal) => this.verifyInput(snapshot, callbacks, signal))
	}

	/** One admission slot and deadline cover extraction, CAPTCHA, website and context cleanup. */
	async verifyImage(
		image: InvoiceImage,
		options: InvoiceOptions = {},
	): Promise<InvoiceImageResult> {
		const snapshot = copyImage(image)
		const callbacks = { onChallenge: options?.onChallenge, onCaptcha: options?.onCaptcha }
		return await this.operation(options, async (signal) => {
			const result = await this.extractImage(snapshot, signal)
			if (result.status === 'needs_review') return result
			return {
				status: 'completed',
				extraction: result,
				verification: await this.verifyInput(result.input, callbacks, signal),
			}
		})
	}

	private async extractImage(image: InvoiceImage, signal: AbortSignal): Promise<InvoiceExtraction> {
		return extraction(await this.model(image, EXTRACTION_PROMPT, signal))
	}

	private async model(image: InvoiceImage, prompt: string, signal: AbortSignal) {
		if (!this.config.vlm || !this.apiKey)
			throw new InvoiceError(
				'VLM_NOT_CONFIGURED',
				'Configure the invoice VLM and its Vault credential before image recognition',
			)
		return await complete(this.config.vlm, this.apiKey, image, prompt, signal)
	}

	private async operation<T>(
		options: InvoiceOptions,
		run: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		if (
			!options ||
			typeof options !== 'object' ||
			(options.signal !== undefined && !(options.signal instanceof AbortSignal)) ||
			(options.onChallenge !== undefined && typeof options.onChallenge !== 'function') ||
			(options.onCaptcha !== undefined && typeof options.onCaptcha !== 'function')
		)
			throw new TypeError(
				'Invoice options require an AbortSignal and optional CAPTCHA/challenge callbacks',
			)
		options.signal?.throwIfAborted()
		const generation = this.generation
		if (!generation?.active) throw new InvoiceError('NOT_RUNNING', 'Invoice plugin is not running')
		if (generation.calls.size >= this.config.maxConcurrent)
			throw new InvoiceError('BUSY', 'Invoice capacity is full')
		const controller = new AbortController()
		const signal = options.signal
			? AbortSignal.any([controller.signal, options.signal])
			: controller.signal
		let task: Promise<T> | undefined
		const owner = this.ctx.caller ?? this.ctx
		const cleanup = owner.effects.defer(
			async () => {
				controller.abort(new InvoiceError('NOT_RUNNING', 'Invoice caller stopped'))
				await task?.then(
					(): undefined => undefined,
					(): undefined => undefined,
				)
			},
			{ tag: 'invoice-call', phase: 'shutdown' },
		)
		const timer = setTimeout(
			() =>
				controller.abort(new InvoiceError('TIMEOUT', 'Invoice operation exceeded its time budget')),
			this.config.timeoutMs,
		)
		try {
			task = Promise.resolve().then(() => {
				signal.throwIfAborted()
				return run(signal)
			})
			generation.calls.set(controller, task)
			return await task
		} finally {
			clearTimeout(timer)
			generation.calls.delete(controller)
			cleanup.cancel()
		}
	}

	private async verifyInput(
		input: InvoiceInput,
		callbacks: Pick<InvoiceOptions, 'onChallenge' | 'onCaptcha'>,
		signal: AbortSignal,
	): Promise<InvoiceVerification> {
		let context: BrowserContext | undefined
		let closing: Promise<void> | undefined
		const close = () => (closing ??= context ? context.close() : Promise.resolve())
		const abort = () => {
			void close().catch(() => {})
		}
		let failed = false
		let failure: unknown
		let result: InvoiceVerification | undefined
		try {
			context = await this.playwright.newContext(
				{ viewport: { width: 1280, height: 1000 }, locale: 'zh-CN' },
				{ signal },
			)
			signal.addEventListener('abort', abort, { once: true })
			signal.throwIfAborted()
			context.setDefaultTimeout(this.config.timeoutMs)
			context.setDefaultNavigationTimeout(this.config.timeoutMs)
			const page = await context.newPage()
			const solver = this.config.vlm
				? async (image: InvoiceImage, instruction: string) => {
						const response = await this.model(
							image,
							`Read this CAPTCHA. The site's instruction is: ${JSON.stringify(instruction)}. Return exactly {"answer":"characters in order"} or {"answer":null} when unclear. No explanation.`,
							signal,
						)
						return typeof response.answer === 'string' &&
							/^[\p{L}\p{N}]{1,8}$/u.test(response.answer)
							? response.answer
							: null
					}
				: undefined
			result = await abortable(
				input.kind === 'fiscal'
					? queryFiscalPortal(page, input.ticket, signal, callbacks.onChallenge)
					: queryTaxPortal(page, input, signal, this.config.captchaAttempts, solver, callbacks),
				signal,
			)
		} catch (error) {
			failed = true
			failure = error
		} finally {
			signal.removeEventListener('abort', abort)
		}
		try {
			await close()
		} catch (error) {
			if (failed)
				throw new AggregateError([failure, error], 'Invoice operation and browser cleanup failed', {
					cause: error,
				})
			throw error
		}
		if (failed) throw failure
		return result!
	}
}
