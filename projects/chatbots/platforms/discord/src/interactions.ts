import { CommandError, type Registration } from '@pluxel/commands'
import {
	closeOwnerInvocations,
	enterOwnerInvocation,
	type OwnerInvocationLease,
} from '@pluxel/core/internal'
import type { Context } from '@pluxel/runtime'
import type { DiscordButtonContext } from './protocol.ts'

export type DiscordButtonConsumer = (context: DiscordButtonContext) => void | Promise<void>

export interface DiscordInteractions {
	on(customIdPrefix: string, consumer: DiscordButtonConsumer): Registration
}

type ActiveRoute = Readonly<{
	owner: Context
	prefix: string
	consumer: DiscordButtonConsumer
	dispose(): void
}>

/** Owner-bound Discord component routes with longest-prefix dispatch. */
export class DiscordInteractionCarrier {
	private readonly routes = new Map<string, ActiveRoute>()
	private readonly views = new WeakMap<Context, DiscordInteractions>()
	private readonly ownersWithInvocationCleanup = new WeakSet<Context>()
	private active = true

	constructor(private readonly ctx: Context) {}

	forOwner(owner: Context): DiscordInteractions {
		if (owner.root !== this.ctx.root) {
			throw new TypeError('Discord interaction owner must belong to the carrier runtime')
		}
		let view = this.views.get(owner)
		if (view) return view
		view = Object.freeze({
			on: (prefix: string, consumer: DiscordButtonConsumer) =>
				this.register(owner, prefix, consumer),
		})
		this.views.set(owner, view)
		return view
	}

	matches(customId: string): boolean {
		return this.match(customId) !== undefined
	}

	async dispatch(context: DiscordButtonContext): Promise<boolean> {
		const route = this.match(context.customId)
		if (!route) return false
		let carrierLease: OwnerInvocationLease | undefined
		let ownerLease: OwnerInvocationLease | undefined
		try {
			carrierLease = enterInvocation(this.ctx, context.signal)
			ownerLease =
				route.owner === this.ctx ? carrierLease : enterInvocation(route.owner, carrierLease.signal)
			await route.consumer(Object.freeze({ ...context, signal: ownerLease.signal }))
			return true
		} catch (error) {
			if (context.signal.aborted) throw context.signal.reason ?? error
			if (ownerLease?.signal.aborted || isCancellation(error)) return true
			throw error
		} finally {
			if (ownerLease && ownerLease !== carrierLease) ownerLease.dispose()
			carrierLease?.dispose()
		}
	}

	dispose(): void {
		if (!this.active) return
		this.active = false
		for (const route of this.routes.values()) route.dispose()
	}

	private register(
		owner: Context,
		customIdPrefix: string,
		consumer: DiscordButtonConsumer,
	): Registration {
		this.assertActive()
		const prefix = customIdPrefix.trim()
		if (!prefix) throw new TypeError('Discord interaction prefix must not be empty')
		if (this.routes.has(prefix)) {
			throw new Error(`Discord interaction prefix is already registered: ${prefix}`)
		}
		let published = true
		let guard: { cancel(): void } | undefined
		let active!: ActiveRoute
		const cleanup = () => {
			if (!published) return
			published = false
			if (this.routes.get(prefix) === active) this.routes.delete(prefix)
		}
		active = {
			owner,
			prefix,
			consumer,
			dispose: () => {
				guard?.cancel()
				cleanup()
			},
		}
		this.routes.set(prefix, active)
		try {
			this.ownInvocationCleanup(owner)
			guard = owner.effects.defer(cleanup, { tag: `DiscordInteraction:${prefix}` })
		} catch (error) {
			cleanup()
			throw error
		}
		return Object.freeze({ name: prefix, dispose: active.dispose })
	}

	private match(customId: string): ActiveRoute | undefined {
		let matched: ActiveRoute | undefined
		for (const route of this.routes.values()) {
			if (
				customId.startsWith(route.prefix) &&
				(!matched || route.prefix.length > matched.prefix.length)
			)
				matched = route
		}
		return matched
	}

	private ownInvocationCleanup(owner: Context): void {
		if (this.ownersWithInvocationCleanup.has(owner)) return
		owner.effects.defer(() => closeOwnerInvocations(owner), {
			tag: 'DiscordInteractionInvocations',
			phase: 'shutdown',
		})
		this.ownersWithInvocationCleanup.add(owner)
	}

	private assertActive(): void {
		if (!this.active) throw new Error('Discord interaction carrier is stopped')
	}
}

function enterInvocation(owner: Context, signal: AbortSignal): OwnerInvocationLease {
	try {
		return enterOwnerInvocation(owner, signal)
	} catch (error) {
		throw new CommandError('ABORTED', 'Interaction cancelled', { cause: error })
	}
}

function isCancellation(error: unknown): boolean {
	return error instanceof CommandError && error.code === 'ABORTED'
}
