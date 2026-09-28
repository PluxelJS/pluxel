import type { EffectsScope, RootContext, PluginNodeAddress } from '@pluxel/core'
import {
	getContextInstallationCapability,
	resolveContextCapability,
	type CorePluginLifecycleHooks,
	type CoreGenerationRejection,
	type ContextCapability,
	type ContextCapabilityAccess,
	type ContextCapabilityInstallation,
} from '@pluxel/core/host'

export type HostServiceDependencies = Readonly<
	Record<string, ContextCapability<any, 'all' | 'root'>>
>
type DependencyValues<T extends HostServiceDependencies> = {
	readonly [K in keyof T]: T[K] extends ContextCapability<infer V, ContextCapabilityAccess>
		? V
		: never
}

/** A fixed, reusable declaration. Resource acquisition belongs in prepare, never declaration evaluation. */
export interface HostService<
	TCapabilities extends readonly ContextCapabilityInstallation[] =
		readonly ContextCapabilityInstallation[],
	TDependencies extends HostServiceDependencies = HostServiceDependencies,
> {
	/** Diagnostic source, not capability identity. */
	readonly name: string
	readonly capabilities: TCapabilities
	/** Explicit host preparation dependencies; omitted means none. Providers are never auto-installed. */
	readonly requires?: TDependencies
	/** Fixed Core publication stages, bound once per root. No IO or registration belongs in this factory. */
	lifecycle?(ctx: RootContext): CorePluginLifecycleHooks
	/** Delete durable service metadata before a stopped fork is removed. Failure retains its policy for retry. */
	removeNodeMetadata?(ctx: RootContext, node: PluginNodeAddress): void | Promise<void>
	/** Runs once per Host, before Plugin admission. Register acquired resources immediately in effects. */
	prepare?(
		options: Readonly<{
			ctx: RootContext
			dependencies: DependencyValues<TDependencies>
			effects: EffectsScope
		}>,
	): void | Promise<void>
}

/** Preserve descriptor projection and infer dependency values from the single requires declaration. */
export function defineHostService<
	const TCapabilities extends readonly ContextCapabilityInstallation[],
	const TDependencies extends HostServiceDependencies = Record<never, never>,
>(service: HostService<TCapabilities, TDependencies>): HostService<TCapabilities, TDependencies> {
	return Object.freeze({
		...service,
		capabilities: Object.freeze([...service.capabilities]) as unknown as TCapabilities,
		...(service.requires ? { requires: Object.freeze({ ...service.requires }) } : {}),
	})
}

export class HostServicePlanError extends Error {
	constructor(
		public readonly code:
			| 'DUPLICATE_CAPABILITY'
			| 'MISSING_DEPENDENCY'
			| 'DEPENDENCY_CYCLE'
			| 'INVALID_DEPENDENCY_SCOPE',
		message: string,
	) {
		super(message)
		this.name = 'HostServicePlanError'
	}
}

/** Snapshot and sort the complete declarations without creating Contexts or invoking factories. */
export function planHostServices(services: readonly HostService[]): readonly HostService[] {
	const fixed = services.map((service) => {
		if (!service || typeof service.name !== 'string' || !service.name.trim())
			throw new TypeError('[host] service declarations require a non-empty name')
		if (!Array.isArray(service.capabilities))
			throw new TypeError(`[host] service ${service.name} must provide capabilities`)
		if (
			service.removeNodeMetadata !== undefined &&
			typeof service.removeNodeMetadata !== 'function'
		)
			throw new TypeError(`[host] service ${service.name} has an invalid metadata cleanup`)
		if (service.lifecycle !== undefined && typeof service.lifecycle !== 'function')
			throw new TypeError(`[host] service ${service.name} has an invalid lifecycle factory`)
		if (service.prepare !== undefined && typeof service.prepare !== 'function')
			throw new TypeError(`[host] service ${service.name} has an invalid prepare callback`)
		return defineHostService(service)
	})
	const providers = new Map<ContextCapability<any, ContextCapabilityAccess>, HostService>()
	for (const service of fixed) {
		for (const installation of service.capabilities) {
			const capability = getContextInstallationCapability(installation)
			const previous = providers.get(capability)
			if (previous)
				throw new HostServicePlanError(
					'DUPLICATE_CAPABILITY',
					`[host] capability ${capability.description} is provided by both ${previous.name} and ${service.name}`,
				)
			providers.set(capability, service)
		}
	}
	const dependencies = new Map<HostService, Set<HostService>>()
	for (const service of fixed) {
		const required = new Set<HostService>()
		for (const [name, capability] of Object.entries(service.requires ?? {})) {
			if ((capability as ContextCapability<any, ContextCapabilityAccess>).access === 'owner')
				throw new HostServicePlanError(
					'INVALID_DEPENDENCY_SCOPE',
					`[host] service ${service.name} requires owner-only capability ${capability.description} during root preparation`,
				)
			const provider = providers.get(capability)
			if (!provider)
				throw new HostServicePlanError(
					'MISSING_DEPENDENCY',
					`[host] service ${service.name} requires unprovided capability ${capability?.description ?? name} (${name})`,
				)
			required.add(provider)
		}
		dependencies.set(service, required)
	}
	const ordered: HostService[] = []
	const pending = new Set(fixed)
	while (pending.size > 0) {
		// Pick the earliest currently available declaration, independent of completion timing.
		const ready = fixed.find(
			(service) =>
				pending.has(service) &&
				[...dependencies.get(service)!].every((provider) => !pending.has(provider)),
		)
		if (!ready)
			throw new HostServicePlanError(
				'DEPENDENCY_CYCLE',
				`[host] cyclic service dependencies: ${[...pending].map((service) => service.name).join(', ')}`,
			)
		pending.delete(ready)
		ordered.push(ready)
	}
	return Object.freeze(ordered)
}

export async function prepareHostServices(
	ctx: RootContext,
	services: readonly HostService[],
): Promise<void> {
	if (nodeMetadataServices.has(ctx))
		throw new Error('[host] services are already prepared for this root')
	nodeMetadataServices.set(ctx, services)
	ctx.effects.defer(
		() => {
			nodeMetadataServices.delete(ctx)
		},
		{ phase: 'shutdown' },
	)
	for (const service of services) {
		const dependencies = Object.create(null) as Record<string, unknown>
		for (const [name, capability] of Object.entries(service.requires ?? {}))
			dependencies[name] = resolveContextCapability(ctx, capability)
		const effects = ctx.effects.scope({ tag: service.name })
		await service.prepare?.({ ctx, effects, dependencies: Object.freeze(dependencies) })
	}
}

/** Bind the fixed plan to Core's sole publication sequence; services do not own a second commit. */
export function createHostServiceLifecycle(
	ctx: RootContext,
	services: readonly HostService[],
): CorePluginLifecycleHooks {
	const hooks = services.flatMap((service) => {
		if (!service.lifecycle) return []
		const value = service.lifecycle(ctx)
		for (const name of [
			'finalizeGeneration',
			'settleGenerations',
			'prepareCommit',
			'publishCommit',
		] as const) {
			if (value[name] !== undefined && typeof value[name] !== 'function')
				throw new TypeError(`[host] service ${service.name} has invalid ${name}`)
		}
		return [Object.freeze({ ...value })]
	})
	if (hooks.length === 0) return Object.freeze({})
	if (hooks.length === 1) return hooks[0]!
	return {
		async finalizeGeneration(generation) {
			for (const hook of hooks) await hook.finalizeGeneration?.(generation)
		},
		async settleGenerations(settlement) {
			const rejected = new Map<CoreGenerationRejection['ctx'], CoreGenerationRejection>()
			for (const hook of hooks) {
				for (const rejection of (await hook.settleGenerations?.(settlement)) || [])
					if (!rejected.has(rejection.ctx)) rejected.set(rejection.ctx, rejection)
			}
			return [...rejected.values()]
		},
		async prepareCommit(publication) {
			for (const hook of hooks) await hook.prepareCommit?.(publication)
		},
		publishCommit(publication) {
			for (const hook of hooks) {
				if (hook.publishCommit?.(publication) !== undefined)
					throw new TypeError('[host] service publishCommit must synchronously return undefined')
			}
			return undefined
		},
	}
}

const nodeMetadataServices = new WeakMap<RootContext, readonly HostService[]>()

/** Metadata is withdrawn in reverse service dependency order within the existing fork transaction. */
export async function removeHostNodeMetadata(
	ctx: RootContext,
	node: PluginNodeAddress,
): Promise<void> {
	for (const service of (nodeMetadataServices.get(ctx) ?? []).toReversed())
		await service.removeNodeMetadata?.(ctx, node)
}
