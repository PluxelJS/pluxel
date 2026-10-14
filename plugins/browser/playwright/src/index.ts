import { BasePlugin, type Context, Plugin } from '@pluxel/core'
import { Vault } from '@pluxel/services/vault'
import {
	chromium,
	type Browser,
	type BrowserContext,
	type BrowserContextOptions,
} from 'playwright-core'
import * as v from 'valibot'
import { acceptsEndpoint, PlaywrightConfig, PlaywrightConnectionSchema } from './config.ts'

export { PlaywrightConfig, PlaywrightVaultSchema } from './config.ts'

/** The connection/caller generation is no longer usable. Restart explicitly after disconnection. */
export class PlaywrightNotRunningError extends Error {
	override readonly name = 'PlaywrightNotRunningError'
	constructor() {
		super('Playwright connection or caller is stopped or disconnected')
	}
}

type Owner = {
	readonly controller: AbortController
	readonly contexts: Set<BrowserContext>
	readonly pending: Set<Promise<unknown>>
	readonly cleanupErrors: unknown[]
	closing?: Promise<void>
}

/** Connects to an externally managed browser without launching or installing one. */
@Plugin({ displayName: 'Playwright' })
export class PlaywrightPlugin extends BasePlugin {
	private readonly config = this.configs.use(PlaywrightConfig)
	private browser: Browser | undefined = undefined
	private active = false
	private readonly owners = new WeakMap<Context, Owner>()
	private readonly activeOwners = new Set<Owner>()

	protected override async init(signal: AbortSignal): Promise<void> {
		let connection: v.InferOutput<typeof PlaywrightConnectionSchema>
		if (this.config.connectionKey !== undefined) {
			const record = await this.ctx.require(Vault).kv().get(this.config.connectionKey)
			const parsed = v.safeParse(PlaywrightConnectionSchema, record.value)
			if (!record.exists || !parsed.success)
				throw new Error('Playwright Vault connection record is missing or invalid')
			connection = parsed.output
		} else {
			connection = { endpoint: this.config.endpoint! }
		}
		if (!acceptsEndpoint(this.config.protocol, connection.endpoint)) {
			throw new Error('Playwright protocol requires a WebSocket endpoint (ws or wss)')
		}
		signal.throwIfAborted()
		let browser: Browser
		try {
			const options = { headers: connection.headers, timeout: this.config.connectTimeoutMs }
			browser =
				this.config.protocol === 'playwright'
					? await chromium.connect(connection.endpoint, options)
					: await chromium.connectOverCDP(connection.endpoint, { ...options, noDefaults: true })
		} catch {
			// Playwright embeds endpoint URLs and server responses in connection errors.
			// Lifecycle reports must never retain a credential-bearing cause.
			throw new Error(
				this.config.protocol === 'playwright'
					? 'Playwright protocol connection failed; check the endpoint, credentials and matching client/server major.minor versions'
					: 'Playwright CDP connection failed; check the endpoint, credentials and remote browser availability',
			)
		}
		this.browser = browser
		const disconnected = () => {
			this.active = false
			for (const owner of this.activeOwners) owner.controller.abort(new PlaywrightNotRunningError())
		}
		browser.on('disconnected', disconnected)
		try {
			this.ctx.effects.defer(
				async () => {
					this.active = false
					for (const owner of this.activeOwners)
						owner.controller.abort(new PlaywrightNotRunningError())
					const errors: unknown[] = []
					const closes = await Promise.allSettled(
						[...this.activeOwners].map((owner) => closeContexts(owner)),
					)
					for (const close of closes) if (close.status === 'rejected') errors.push(close.reason)
					try {
						// Both connection APIs disconnect their transport without terminating the remote browser.
						await browser.close()
					} catch (error) {
						errors.push(error)
					}
					const owners = await Promise.allSettled(
						[...this.activeOwners].map((owner) => this.closeOwner(owner)),
					)
					for (const owner of owners) if (owner.status === 'rejected') errors.push(owner.reason)
					browser.off('disconnected', disconnected)
					this.browser = undefined
					if (errors.length > 0)
						throw new AggregateError(errors, 'Playwright connection cleanup failed')
				},
				{ tag: 'playwright-connection', phase: 'shutdown' },
			)
		} catch (error) {
			browser.off('disconnected', disconnected)
			await browser.close()
			this.browser = undefined
			throw error
		}
		signal.throwIfAborted()
		if (!browser.isConnected()) throw new PlaywrightNotRunningError()
		this.active = true
	}

	/**
	 * Creates an isolated, native Playwright context. Close it in finally after use.
	 * Caller/provider stop closes outstanding contexts. signal cancels acquisition only;
	 * an uncancellable late SDK result is closed before its acquisition task is drained.
	 * SDK operation failures propagate unchanged. No automatic reconnection.
	 */
	async newContext(
		options?: BrowserContextOptions,
		lifecycle: { signal?: AbortSignal } = {},
	): Promise<BrowserContext> {
		lifecycle.signal?.throwIfAborted()
		const browser = this.browser
		if (!this.active || !browser?.isConnected()) throw new PlaywrightNotRunningError()
		const owner = this.owner()
		const signal = lifecycle.signal
			? AbortSignal.any([owner.controller.signal, lifecycle.signal])
			: owner.controller.signal
		signal.throwIfAborted()
		const acquisition = (async () => {
			const context = await browser.newContext(options)
			if (signal.aborted || !this.active || !browser.isConnected()) {
				try {
					await context.close()
				} catch (error) {
					owner.cleanupErrors.push(error)
					throw error
				}
				signal.throwIfAborted()
				throw new PlaywrightNotRunningError()
			}
			owner.contexts.add(context)
			context.once('close', () => owner.contexts.delete(context))
			return context
		})()
		owner.pending.add(acquisition)
		void acquisition.finally(() => owner.pending.delete(acquisition)).catch(() => {})
		return await waitForAcquisition(acquisition, signal)
	}

	private owner(): Owner {
		const context = this.ctx.caller ?? this.ctx
		const existing = this.owners.get(context)
		if (existing) {
			existing.controller.signal.throwIfAborted()
			return existing
		}
		const owner: Owner = {
			controller: new AbortController(),
			contexts: new Set(),
			pending: new Set(),
			cleanupErrors: [],
		}
		this.owners.set(context, owner)
		this.activeOwners.add(owner)
		try {
			if (context !== this.ctx) {
				context.effects.defer(() => this.closeOwner(owner), {
					tag: 'playwright-contexts',
					phase: 'shutdown',
				})
			}
		} catch (error) {
			owner.controller.abort(new PlaywrightNotRunningError())
			this.activeOwners.delete(owner)
			throw error
		}
		return owner
	}

	private closeOwner(owner: Owner): Promise<void> {
		owner.controller.abort(new PlaywrightNotRunningError())
		owner.closing ??= (async () => {
			try {
				await closeContexts(owner)
			} catch (error) {
				owner.cleanupErrors.push(error)
			} finally {
				await Promise.allSettled(owner.pending)
				this.activeOwners.delete(owner)
			}
			if (owner.cleanupErrors.length > 0) {
				throw new AggregateError(owner.cleanupErrors, 'Playwright context cleanup failed')
			}
		})()
		return owner.closing
	}
}

async function closeContexts(owner: Owner): Promise<void> {
	const results = await Promise.allSettled([...owner.contexts].map((context) => context.close()))
	const failed = results.find((result) => result.status === 'rejected')
	if (failed?.status === 'rejected') throw failed.reason
}

async function waitForAcquisition<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	let abort: (() => void) | undefined
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				abort = () => reject(signal.reason)
				signal.addEventListener('abort', abort, { once: true })
				if (signal.aborted) abort()
			}),
		])
	} finally {
		if (abort) signal.removeEventListener('abort', abort)
	}
}
