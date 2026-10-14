import { BasePlugin, Plugin } from '@pluxel/core'
import { PlaywrightPlugin } from '@pluxel/playwright'
import type { BrowserContext } from 'playwright-core'
import { FiscalTicketConfig } from './config.ts'
import {
	FiscalTicketError,
	type FiscalTicketInput,
	type FiscalTicketResult,
	type FiscalTicketVerifyOptions,
} from './contracts.ts'
import { validateInput } from './input.ts'
import { abortable, queryPortal } from './portal.ts'

export { FiscalTicketConfig } from './config.ts'
export {
	FiscalTicketError,
	type FiscalTicketInput,
	type FiscalTicketResult,
	type FiscalTicketVerifyOptions,
} from './contracts.ts'

type Generation = { active: boolean; calls: Map<AbortController, Promise<FiscalTicketResult>> }

/** Experimental national fiscal-ticket portal adapter; does not install or launch browsers. */
@Plugin({ displayName: 'Fiscal ticket verification', forkable: true })
export class FiscalTicketPlugin extends BasePlugin {
	private readonly config = this.configs.use(FiscalTicketConfig)
	private generation: Generation | undefined = undefined

	constructor(private readonly playwright: PlaywrightPlugin) {
		super()
	}

	protected override init() {
		const generation: Generation = { active: true, calls: new Map() }
		this.generation = generation
		this.ctx.effects.defer(
			async () => {
				generation.active = false
				for (const controller of generation.calls.keys())
					controller.abort(new FiscalTicketError('NOT_RUNNING', 'Fiscal ticket plugin stopped'))
				await Promise.allSettled(generation.calls.values())
				if (this.generation === generation) this.generation = undefined
			},
			{ tag: 'fiscal-ticket-operations', phase: 'shutdown' },
		)
	}

	/** One query, with an isolated context closed before this method settles. No automatic retries. */
	async verify(
		input: FiscalTicketInput,
		options: FiscalTicketVerifyOptions = {},
	): Promise<FiscalTicketResult> {
		const ticket = validateInput(input)
		if (!options || typeof options !== 'object')
			throw new TypeError('Fiscal ticket options must be an object')
		if (options.onChallenge !== undefined && typeof options.onChallenge !== 'function')
			throw new TypeError('onChallenge must be a function')
		if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
			throw new TypeError('signal must be an AbortSignal')
		options.signal?.throwIfAborted()
		const generation = this.generation
		if (!generation?.active)
			throw new FiscalTicketError('NOT_RUNNING', 'Fiscal ticket plugin is not running')
		if (generation.calls.size >= this.config.maxConcurrent)
			throw new FiscalTicketError('BUSY', 'Fiscal ticket verification capacity is full')
		const controller = new AbortController()
		const signal = options.signal
			? AbortSignal.any([controller.signal, options.signal])
			: controller.signal
		let task: Promise<FiscalTicketResult> | undefined
		const owner = this.ctx.caller ?? this.ctx
		const cleanup = owner.effects.defer(
			async () => {
				controller.abort(new FiscalTicketError('NOT_RUNNING', 'Fiscal ticket caller stopped'))
				await task?.then(
					(): undefined => undefined,
					(): undefined => undefined,
				)
			},
			{ tag: 'fiscal-ticket-call', phase: 'shutdown' },
		)
		const deadline = setTimeout(
			() =>
				controller.abort(
					new FiscalTicketError(
						'TIMEOUT',
						'Fiscal ticket verification exceeded its configured time budget',
					),
				),
			this.config.timeoutMs,
		)
		try {
			task = this.run(ticket, options.onChallenge, signal)
			generation.calls.set(controller, task)
			return await task
		} finally {
			clearTimeout(deadline)
			generation.calls.delete(controller)
			cleanup.cancel()
		}
	}

	private async run(
		input: FiscalTicketInput,
		onChallenge: FiscalTicketVerifyOptions['onChallenge'],
		signal: AbortSignal,
	): Promise<FiscalTicketResult> {
		let context: BrowserContext | undefined
		let closing: Promise<void> | undefined
		const close = () => (closing ??= context ? context.close() : Promise.resolve())
		const abort = () => {
			void close().catch(() => {})
		}
		let failed = false
		let failure: unknown
		let result: FiscalTicketResult | undefined
		try {
			context = await this.playwright.newContext(
				{ viewport: { width: 1280, height: 900 } },
				{ signal },
			)
			// Register only after acquisition; the connector owns late acquisition cleanup.
			signal.addEventListener('abort', abort, { once: true })
			signal.throwIfAborted()
			context.setDefaultTimeout(this.config.timeoutMs)
			context.setDefaultNavigationTimeout(this.config.timeoutMs)
			const page = await context.newPage()
			result = await abortable(queryPortal(page, input, signal, onChallenge), signal)
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
				throw new AggregateError(
					[failure, error],
					'Fiscal ticket operation and context cleanup failed',
					{ cause: error },
				)
			throw error
		}
		if (failed) throw failure
		return result!
	}
}
