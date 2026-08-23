import type { LoggerServiceConfig, ContextLogger } from '../logger/LoggerService'
import type { PluginNodeInfo } from '../plugins/runtime/PluginDefinitions'
import type { EffectsScope } from '../services/effects/EffectsService'
import type { PluginServiceConfig } from '../plugins/runtime/PluginService'

export const CONTEXT_CAPABILITY_TYPE: unique symbol = Symbol('pluxel.context.capability')
const CONTEXT_STATE = Symbol('pluxel.context.state')
const CONSTRUCTING = Symbol('pluxel.context.constructing')
const PLAN_INDEXES = new WeakMap<ContextPlan, ReadonlyMap<AnyCapability, number>>()

type CapabilityScope = 'root' | 'generation' | 'owner-view'

export type ContextCapability<T> = Readonly<{
	readonly [CONTEXT_CAPABILITY_TYPE]: T
	readonly description: string
}>

type AnyCapability = ContextCapability<unknown>

type RootInstallation<T> = Readonly<{
	capability: ContextCapability<T>
	scope: 'root'
	property?: PropertyKey
	create(ctx: Context): T
	/** Construct this root backing during host preparation even when no prepare hook is needed. */
	eager?: true
	/** Leaf startup hook. Dependencies must be resolved by the capability factory. */
	prepare?(value: T): void | Promise<void>
}>

type GenerationInstallation<T> = Readonly<{
	capability: ContextCapability<T>
	scope: 'generation'
	property?: PropertyKey
	create(ctx: Context): T
}>

type OwnerViewInstallation<TRoot, TView> = Readonly<{
	capability: ContextCapability<TView>
	scope: 'owner-view'
	property?: PropertyKey
	createRoot(root: RootContext): TRoot
	createView(rootValue: TRoot, owner: Context): TView
	/** Construct this root backing during host preparation even when no prepare hook is needed. */
	eager?: true
	/** Leaf startup hook. Dependencies must be resolved by the capability factory. */
	prepare?(rootValue: TRoot): void | Promise<void>
}>

export type ContextCapabilityInstallation<T = unknown> =
	| RootInstallation<T>
	| GenerationInstallation<T>
	| OwnerViewInstallation<unknown, T>

type CompiledInstallation = Readonly<{
	capability: AnyCapability
	scope: CapabilityScope
	property?: PropertyKey
	create?: (ctx: Context) => unknown
	createRoot?: (root: RootContext) => unknown
	createView?: (rootValue: unknown, owner: Context) => unknown
	eager?: true
	prepare?: (value: unknown) => void | Promise<void>
}>

type ContextResolver = (ctx: Context) => unknown

export type ContextPlan = Readonly<{
	name: string
	prototype: object
	installations: readonly CompiledInstallation[]
	resolvers: readonly ContextResolver[]
	eager: readonly number[]
}>

type ContextState = {
	readonly plan: ContextPlan
	readonly root: RootContext
	readonly generation: Context
	readonly parent?: Context
	readonly name: string
	readonly rootValues: unknown[]
	readonly generationValues: unknown[]
	ownerValues?: unknown[]
	prepareTasks?: Array<Promise<void> | undefined>
}

/** Plugin-facing owner and capability projection. Runtime construction is host-owned. */
export interface Context {
	readonly root: RootContext
	readonly parent?: Context
	readonly name: string
	readonly logger: ContextLogger
	readonly effects: EffectsScope
	readonly pluginInfo?: PluginNodeInfo
	readonly caller?: Context
	readonly [Symbol.toStringTag]: 'PluxelContext'
}

/** Host root with plan-installed, host-owned capabilities. */
export interface RootContext extends Context {}

/** Context owned by one running Plugin generation (and its Parts). */
export interface PluginContext extends Context {
	readonly pluginInfo: PluginNodeInfo
}

/** Public configuration shared by Core-based host constructors. */
export interface CoreHostConfig {
	name?: string
	logger?: LoggerServiceConfig
	plugins?: PluginServiceConfig
}

// Deliberately do not `implements Context`: downstream packages augment the public interface with
// plan-installed properties that this plan-neutral base class cannot declare.
class ContextImpl {
	declare readonly [CONTEXT_STATE]: ContextState

	get [Symbol.toStringTag](): 'PluxelContext' {
		return 'PluxelContext'
	}

	get root(): RootContext {
		return stateOf(this as unknown as Context).root
	}

	get parent(): Context | undefined {
		return stateOf(this as unknown as Context).parent
	}

	get name(): string {
		return stateOf(this as unknown as Context).name
	}

	declare readonly logger: ContextLogger
	declare readonly effects: EffectsScope
	declare readonly pluginInfo?: PluginNodeInfo
	declare readonly caller?: Context
}

export function defineContextCapability<T>(description: string): ContextCapability<T> {
	if (!description) throw new TypeError('[pluxel/core] Context capability description is required')
	return Object.freeze({ description }) as ContextCapability<T>
}

export function installRootCapability<T>(
	capability: ContextCapability<T>,
	options: Omit<RootInstallation<T>, 'capability' | 'scope'>,
): RootInstallation<T> {
	return Object.freeze({ capability, scope: 'root', ...options })
}

export function installGenerationCapability<T>(
	capability: ContextCapability<T>,
	options: Omit<GenerationInstallation<T>, 'capability' | 'scope'>,
): GenerationInstallation<T> {
	return Object.freeze({ capability, scope: 'generation', ...options })
}

export function installOwnerViewCapability<TRoot, TView>(
	capability: ContextCapability<TView>,
	options: Omit<OwnerViewInstallation<TRoot, TView>, 'capability' | 'scope'>,
): OwnerViewInstallation<TRoot, TView> {
	return Object.freeze({ capability, scope: 'owner-view', ...options })
}

export function createContextPlan(
	name: string,
	installations: readonly ContextCapabilityInstallation[],
): ContextPlan {
	if (!name) throw new TypeError('[pluxel/core] Context plan name is required')
	const indexByCapability = new Map<AnyCapability, number>()
	const properties = new Set<PropertyKey>()
	const compiled: CompiledInstallation[] = []
	const resolvers: ContextResolver[] = []
	const eager: number[] = []
	const prototype = Object.create(ContextImpl.prototype) as object

	for (const source of installations) {
		const capability = source.capability as AnyCapability
		if (indexByCapability.has(capability)) {
			throw new Error(
				`[pluxel/core] Context plan ${name} installs ${capability.description} more than once`,
			)
		}
		const index = compiled.length
		indexByCapability.set(capability, index)
		const installation = Object.freeze({ ...source }) as CompiledInstallation
		compiled.push(installation)
		const resolver = compileResolver(installation, index)
		resolvers.push(resolver)
		if (installation.eager || installation.prepare) eager.push(index)
		if (installation.property === undefined) continue
		if (properties.has(installation.property) || installation.property in ContextImpl.prototype) {
			throw new Error(
				`[pluxel/core] Context plan ${name} has a duplicate property ${String(installation.property)}`,
			)
		}
		properties.add(installation.property)
		Object.defineProperty(prototype, installation.property, {
			configurable: false,
			enumerable: false,
			get(this: Context) {
				return resolver(this)
			},
		})
	}

	Object.freeze(prototype)
	const plan = Object.freeze({
		name,
		prototype,
		installations: Object.freeze(compiled),
		resolvers: Object.freeze(resolvers),
		eager: Object.freeze(eager),
	})
	PLAN_INDEXES.set(plan, indexByCapability)
	return plan
}

export function createRootContext(plan: ContextPlan, name = 'root'): RootContext {
	const values: unknown[] = []
	const root = allocateContext(plan) as RootContext
	installState(root, {
		plan,
		root,
		generation: root,
		name,
		rootValues: values,
		generationValues: [],
	})
	return root
}

export function createGenerationContext(root: RootContext, name: string): Context {
	const rootState = stateOf(root)
	const ctx = allocateContext(rootState.plan)
	installState(ctx, {
		plan: rootState.plan,
		root,
		generation: ctx,
		name,
		rootValues: rootState.rootValues,
		generationValues: [],
	})
	return ctx
}

export function createOwnerContext(parent: Context, name: string): Context {
	const parentState = stateOf(parent)
	const ctx = allocateContext(parentState.plan)
	installState(ctx, {
		plan: parentState.plan,
		root: parentState.root,
		generation: parentState.generation,
		parent,
		name,
		rootValues: parentState.rootValues,
		generationValues: parentState.generationValues,
	})
	return ctx
}

/** @internal Derive one dependency-edge caller view without creating a containment parent. */
export function createCallerContextView(provider: Context, caller: Context): Context {
	const providerState = stateOf(provider)
	const ctx = allocateContext(providerState.plan)
	installState(ctx, {
		plan: providerState.plan,
		root: providerState.root,
		generation: providerState.generation,
		parent: providerState.parent,
		name: providerState.name,
		rootValues: providerState.rootValues,
		generationValues: providerState.generationValues,
	})
	Object.defineProperty(ctx, 'caller', {
		value: caller,
		writable: false,
		enumerable: false,
		configurable: false,
	})
	return ctx
}

export function resolveContextCapability<T>(ctx: Context, capability: ContextCapability<T>): T {
	const state = stateOf(ctx)
	const index = PLAN_INDEXES.get(state.plan)!.get(capability as AnyCapability)
	if (index === undefined) {
		throw new Error(
			`[pluxel/core] Context plan ${state.plan.name} does not install ${capability.description}`,
		)
	}
	return state.plan.resolvers[index]!(ctx) as T
}

/**
 * Construct every eager root backing and run its optional prepare hook exactly once per successful
 * attempt.
 *
 * `prepare` callbacks are leaf hooks: they MUST NOT call this aggregator. Capability dependencies
 * belong in `create`/`createRoot` and are resolved through slots before preparation begins.
 */
export async function prepareContextCapabilities(ctx: Context): Promise<void> {
	const root = ctx.root
	const state = stateOf(root)
	for (const index of state.plan.eager) {
		const existing = state.prepareTasks?.[index]
		if (existing) {
			await existing
			continue
		}
		const installation = state.plan.installations[index]!
		const value = resolvePrepareValue(root, state, index, installation)
		let task!: Promise<void>
		task = Promise.resolve()
			.then(() => installation.prepare?.(value))
			.catch((error: unknown) => {
				if (state.prepareTasks?.[index] === task) state.prepareTasks[index] = undefined
				throw error
			})
		;(state.prepareTasks ??= [])[index] = task
		await task
	}
}

function resolvePrepareValue(
	root: RootContext,
	state: ContextState,
	index: number,
	installation: CompiledInstallation,
): unknown {
	if (installation.scope !== 'owner-view') return state.plan.resolvers[index]!(root)
	const current = state.rootValues[index]
	if (current !== undefined) return readCached(current, installation.capability)
	return constructCached(
		state.rootValues,
		index,
		installation.capability,
		installation.createRoot!,
		root,
	)
}

function allocateContext(plan: ContextPlan): Context {
	return Object.create(plan.prototype) as Context
}

function installState(ctx: Context, state: ContextState): void {
	Object.defineProperty(ctx, CONTEXT_STATE, {
		value: state,
		configurable: false,
		enumerable: false,
		writable: false,
	})
}

function stateOf(ctx: Context): ContextState {
	const state = (ctx as unknown as { [CONTEXT_STATE]?: ContextState })[CONTEXT_STATE]
	if (!state) throw new TypeError('[pluxel/core] Invalid Context implementation')
	return state
}

function compileResolver(installation: CompiledInstallation, index: number): ContextResolver {
	const capability = installation.capability
	if (installation.scope === 'root') {
		const create = installation.create!
		return (ctx) => {
			const state = stateOf(ctx)
			const current = state.rootValues[index]
			if (current !== undefined) return readCached(current, capability)
			return constructCached(state.rootValues, index, capability, create, state.root)
		}
	}
	if (installation.scope === 'generation') {
		const create = installation.create!
		return (ctx) => {
			const state = stateOf(ctx)
			const current = state.generationValues[index]
			if (current !== undefined) return readCached(current, capability)
			return constructCached(state.generationValues, index, capability, create, state.generation)
		}
	}

	const createRoot = installation.createRoot!
	const createView = installation.createView!
	return (ctx) => {
		const state = stateOf(ctx)
		const ownerValues = (state.ownerValues ??= [])
		const current = ownerValues[index]
		if (current !== undefined) return readCached(current, capability)

		const rootCurrent = state.rootValues[index]
		const rootValue =
			rootCurrent === undefined
				? constructCached(state.rootValues, index, capability, createRoot, state.root)
				: readCached(rootCurrent, capability)
		return constructOwnerView(ownerValues, index, capability, createView, rootValue, ctx)
	}
}

function readCached(current: unknown, capability: AnyCapability): unknown {
	if (current === CONSTRUCTING) {
		throw new Error(
			`[pluxel/core] Context capability construction cycle at ${capability.description}`,
		)
	}
	return current
}

function constructCached<TContext extends Context>(
	values: unknown[],
	index: number,
	capability: AnyCapability,
	create: (ctx: TContext) => unknown,
	ctx: TContext,
): unknown {
	values[index] = CONSTRUCTING
	try {
		const value = create(ctx)
		if (value === undefined) {
			throw new TypeError(
				`[pluxel/core] Context capability ${capability.description} returned undefined`,
			)
		}
		values[index] = value
		return value
	} catch (error) {
		values[index] = undefined
		throw error
	}
}

function constructOwnerView(
	values: unknown[],
	index: number,
	capability: AnyCapability,
	create: (rootValue: unknown, owner: Context) => unknown,
	rootValue: unknown,
	owner: Context,
): unknown {
	values[index] = CONSTRUCTING
	try {
		const value = create(rootValue, owner)
		if (value === undefined) {
			throw new TypeError(
				`[pluxel/core] Context capability ${capability.description} returned undefined`,
			)
		}
		values[index] = value
		return value
	} catch (error) {
		values[index] = undefined
		throw error
	}
}
