import {
	getServiceDefinitionKey,
	getServiceDefinitionAccess,
	resolveContextService,
} from '@pluxel/core/internal'
import {
	EffectsService,
	type EffectsScope,
	type RootContext,
	type PluginNodeAddress,
	type PluginConstructor,
} from '@pluxel/core'
import {
	getServiceInstallationDefinition,
	type CorePluginLifecycleHooks,
	type CoreGenerationRejection,
	type ServiceDefinition,
	type ServiceAccess,
	type ServiceInstallation,
} from '@pluxel/core/host'

export type HostServiceDependencies = Readonly<
	Record<string, ServiceDefinition<any, 'all' | 'root'>>
>
type DependencyValues<T extends HostServiceDependencies> = {
	readonly [K in keyof T]: T[K] extends ServiceDefinition<infer V, ServiceAccess> ? V : never
}

/** A fixed, reusable declaration. Resource acquisition belongs in prepare, never declaration evaluation. */
export interface HostService<
	TProvides extends readonly ServiceInstallation[] = readonly ServiceInstallation[],
	TDependencies extends HostServiceDependencies = HostServiceDependencies,
> {
	/** Diagnostic source, not definition identity. */
	readonly name: string
	readonly provides: TProvides
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
			/** Complete initial definitions, already admitted before service resource acquisition. */
			plugins: readonly PluginConstructor[]
			dependencies: DependencyValues<TDependencies>
			effects: EffectsScope
		}>,
	): void | Promise<void>
}

/** Capture fixed service installations and infer dependency values from the single requires declaration. */
export function defineHostService<
	const TProvides extends readonly ServiceInstallation[],
	const TDependencies extends HostServiceDependencies = Record<never, never>,
>(service: HostService<TProvides, TDependencies>): HostService<TProvides, TDependencies> {
	if (!service || typeof service.name !== 'string' || !service.name.trim())
		throw new TypeError('[host] service declarations require a non-empty name')
	if (!Array.isArray(service.provides))
		throw new TypeError(`[host] service ${service.name} must provide a services installation list`)
	if (service.removeNodeMetadata !== undefined && typeof service.removeNodeMetadata !== 'function')
		throw new TypeError(`[host] service ${service.name} has an invalid metadata cleanup`)
	if (service.lifecycle !== undefined && typeof service.lifecycle !== 'function')
		throw new TypeError(`[host] service ${service.name} has an invalid lifecycle factory`)
	if (service.prepare !== undefined && typeof service.prepare !== 'function')
		throw new TypeError(`[host] service ${service.name} has an invalid prepare callback`)
	return Object.freeze({
		...service,
		provides: Object.freeze([...service.provides]) as unknown as TProvides,
		...(service.requires ? { requires: Object.freeze({ ...service.requires }) } : {}),
	})
}

export class HostServicePlanError extends Error {
	constructor(
		public readonly code:
			| 'DUPLICATE_SERVICE'
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
	const fixed = services.map(defineHostService)
	const providers = new Map<ReturnType<typeof getServiceDefinitionKey>, HostService>()
	for (const service of fixed) {
		for (const installation of service.provides) {
			const definition = getServiceInstallationDefinition(installation)
			const key = getServiceDefinitionKey(definition)
			const previous = providers.get(key)
			if (previous)
				throw new HostServicePlanError(
					'DUPLICATE_SERVICE',
					`[host] definition ${typeof definition === 'function' ? definition.name : String(getServiceDefinitionKey(definition))} is provided by both ${previous.name} and ${service.name}`,
				)
			providers.set(key, service)
		}
	}
	const dependencies = new Map<HostService, Set<HostService>>()
	for (const service of fixed) {
		const required = new Set<HostService>()
		for (const [name, definition] of Object.entries(service.requires ?? {})) {
			if (getServiceDefinitionAccess(definition) === 'owner')
				throw new HostServicePlanError(
					'INVALID_DEPENDENCY_SCOPE',
					`[host] service ${service.name} requires owner-only definition ${typeof definition === 'function' ? definition.name : String(getServiceDefinitionKey(definition))} during root preparation`,
				)
			const provider = providers.get(getServiceDefinitionKey(definition))
			if (!provider)
				throw new HostServicePlanError(
					'MISSING_DEPENDENCY',
					`[host] service ${service.name} requires unprovided definition ${typeof definition === 'function' ? definition.name : name} (${name})`,
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
	plugins: readonly PluginConstructor[],
): Promise<void> {
	if (nodeMetadataServices.has(ctx))
		throw new Error('[host] services are already prepared for this root')
	nodeMetadataServices.set(ctx, services)
	ctx.service(EffectsService).defer(
		() => {
			nodeMetadataServices.delete(ctx)
		},
		{ phase: 'shutdown' },
	)
	for (const service of services) {
		const dependencies = Object.create(null) as Record<string, unknown>
		for (const [name, definition] of Object.entries(service.requires ?? {}))
			dependencies[name] = resolveContextService(ctx, definition)
		const effects = ctx.service(EffectsService).scope({ tag: service.name })
		await service.prepare?.({ ctx, effects, plugins, dependencies: Object.freeze(dependencies) })
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
