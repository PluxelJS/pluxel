import type { Context, PluginContext } from '../../context/Context'
import { closeConsumerInvocations, closeOwnerInvocations } from '../../internal/owner-invocations'
import {
	EffectsDisposedError,
	type Cleanup,
	type DisposableLike,
} from '../../services/effects/EffectsService'
import type { PluginConstructor } from '../types'
import type { PluginDefinitionAddress } from '../runtime/identity'
import type { PluginPartDefinitionTree } from '../runtime/part-definition'
import { createPluginConfigs, type PluginConfigs } from './PluginConfigs'
import {
	closeConfigUpdateRegistrationWindow,
	openConfigUpdateRegistrationWindow,
} from './ConfigUpdate'
import { OptionalPluginBindings } from './OptionalPluginBindings'
import {
	createRootPluginParts,
	closePluginPartConsumerInvocations,
	closePluginPartInvocations,
	finalizePluginParts,
	startPluginParts,
	assignPluginPartConfig,
	type PluginParts,
} from './PluginPart'
import { LATE_INIT_CLEANUP_ERROR } from './symbols'

type RootPluginParts = ReturnType<typeof createRootPluginParts>

type PluginGenerationState = {
	readonly ctx: PluginContext
	readonly parts: RootPluginParts
	initActive: boolean
	optional?: OptionalPluginBindings
	configs?: PluginConfigs
}

type ConstructionFrame = {
	readonly expectedImplementation: PluginConstructor
	readonly ctx: PluginContext
	readonly parts: PluginPartDefinitionTree
	readonly resolveRequirement: PluginRequirementResolver
	readonly partContexts: Set<Context>
	consumed: boolean
}

/** @internal Resolve only providers already admitted by the owning Plugin graph. */
export type PluginRequirementResolver = (
	requirement: PluginDefinitionAddress,
	consumer: Context,
) => BasePlugin

const instanceState = new WeakMap<BasePlugin, PluginGenerationState>()
const callerSurfaceByInstance = new WeakMap<BasePlugin, readonly PropertyKey[]>()
const constructionStack: ConstructionFrame[] = []

function captureCallerSurface(plugin: BasePlugin): readonly PropertyKey[] {
	const properties: PropertyKey[] = []
	const seen = new Set<PropertyKey>()
	let current: object | null = plugin
	while (current && current !== Object.prototype) {
		for (const property of Reflect.ownKeys(current)) {
			if (property === 'constructor' || seen.has(property)) continue
			seen.add(property)
			properties.push(property)
		}
		current = Reflect.getPrototypeOf(current) as object | null
	}
	return Object.freeze(properties)
}

function releaseConstructionFrame(frame: ConstructionFrame, cause?: unknown): void {
	const popped = constructionStack.pop()
	if (popped === frame) return
	constructionStack.length = 0
	throw new Error('[pluxel/core] Plugin construction stack was corrupted', { cause })
}

export type PluginCleanup = void | Cleanup | DisposableLike

/** @internal Core-only adapter consumed by the generation lifecycle actor. */
export interface PluginLifecycleAdapter<_C extends Context = Context> {
	init?: (signal: AbortSignal) => PluginCleanup | Promise<PluginCleanup>
	finalize?: (signal: AbortSignal) => void | Promise<void>
	drain: () => Promise<void>
	subscribeErrors?: (cb: (err: unknown) => void) => undefined | (() => void)
}

export type PluginContextOf<P extends BasePlugin> =
	P extends BasePlugin<infer C> ? C : PluginContext

function stateOf(plugin: BasePlugin): PluginGenerationState {
	const state = instanceState.get(plugin)
	if (!state) throw new TypeError('[pluxel/core] Invalid Plugin instance')
	return state
}

function isDisposable(value: unknown): value is DisposableLike {
	return (
		!!value &&
		typeof value === 'object' &&
		typeof (value as { dispose?: unknown }).dispose === 'function'
	)
}

async function disposeLate(resource: Cleanup | DisposableLike): Promise<void> {
	if (typeof resource === 'function') await resource()
	else await resource.dispose()
}

function lateCleanupError(cause: unknown): Error {
	const detail = cause instanceof Error ? cause.message : String(cause)
	const error = new Error(`Late Plugin init cleanup failed: ${detail}`, { cause }) as Error & {
		[LATE_INIT_CLEANUP_ERROR]?: true
	}
	Object.defineProperty(error, LATE_INIT_CLEANUP_ERROR, { value: true })
	return error
}

async function adoptCleanup(ctx: Context, resource: PluginCleanup): Promise<void> {
	if (resource === undefined) return
	try {
		if (typeof resource === 'function') ctx.effects.defer(resource)
		else if (isDisposable(resource)) ctx.effects.own(resource)
		else throw new TypeError('[pluxel/core] Plugin init() returned an invalid cleanup resource')
	} catch (error) {
		if (!(error instanceof EffectsDisposedError)) throw error
		try {
			await disposeLate(resource as Cleanup | DisposableLike)
		} catch (cause) {
			throw lateCleanupError(cause)
		}
	}
}

/**
 * Plugin author base class. Construction is admitted only by Core's synchronous generation
 * construction stack; constructors, nodes and generations are deliberately different concepts.
 */
export abstract class BasePlugin<C extends PluginContext = PluginContext> {
	constructor() {
		const frame = constructionStack.at(-1)
		if (!frame || frame.consumed || new.target !== frame.expectedImplementation) {
			throw new Error('[pluxel/core] Plugin instances can only be constructed by Core')
		}
		frame.consumed = true
		const state: PluginGenerationState = {
			ctx: frame.ctx,
			parts: createRootPluginParts(
				this,
				frame.ctx,
				frame.parts,
				frame.resolveRequirement,
				frame.partContexts,
			),
			initActive: false,
		}
		instanceState.set(this, state)
	}

	get ctx(): C {
		return stateOf(this).ctx as C
	}

	protected get plugins(): OptionalPluginBindings {
		const state = stateOf(this)
		return (state.optional ??= new OptionalPluginBindings(state.ctx, () => state.initActive))
	}

	protected get parts(): PluginParts<this> {
		return stateOf(this).parts as unknown as PluginParts<this>
	}

	protected get configs(): PluginConfigs {
		const state = stateOf(this)
		return (state.configs ??= createPluginConfigs(state.ctx))
	}

	protected init?(_signal: AbortSignal): PluginCleanup | Promise<PluginCleanup>
}

/** @internal Construct exactly one Plugin generation with the candidate implementation. */
export function constructPluginGeneration<T extends BasePlugin>(
	implementation: PluginConstructor,
	ctx: PluginContext,
	parts: PluginPartDefinitionTree,
	constructorRequires: readonly PluginDefinitionAddress[],
	resolveRequirement: PluginRequirementResolver,
	partContexts: Set<Context>,
): T {
	const frame: ConstructionFrame = {
		expectedImplementation: implementation,
		ctx,
		parts,
		resolveRequirement,
		partContexts,
		consumed: false,
	}
	constructionStack.push(frame)
	let plugin: T
	try {
		const dependencies = constructorRequires.map((requirement) =>
			resolveRequirement(requirement, ctx),
		)
		plugin = Reflect.construct(implementation, dependencies, implementation) as T
		if (!frame.consumed || !instanceState.has(plugin)) {
			throw new TypeError('[pluxel/core] Plugin implementation must extend BasePlugin')
		}
		finalizePluginParts(stateOf(plugin).parts)
		callerSurfaceByInstance.set(plugin, captureCallerSurface(plugin))
	} catch (cause) {
		releaseConstructionFrame(frame, cause)
		throw cause
	}
	releaseConstructionFrame(frame)
	return plugin
}

/** @internal Return the generation Context without exposing a public construction symbol. */
export function getPluginGenerationContext(plugin: BasePlugin): Context {
	return stateOf(plugin).ctx
}

/** @internal Project a validated composite config into one Plugin generation and its Parts. */
export function assignPluginGenerationPartConfig(plugin: BasePlugin, value: unknown): void {
	assignPluginPartConfig(stateOf(plugin).parts, value)
}

/** @internal Return the ordinary property keys captured when generation construction completed. */
export function getPluginGenerationCallerSurface(plugin: BasePlugin): readonly PropertyKey[] {
	stateOf(plugin)
	const surface = callerSurfaceByInstance.get(plugin)
	if (!surface) throw new TypeError('[pluxel/core] Plugin generation caller surface is not ready')
	return surface
}

/** @internal Let BasePlugin's stateful getters operate on a caller facade. */
export function registerPluginGenerationFacade(facade: BasePlugin, provider: BasePlugin): void {
	if (instanceState.has(facade))
		throw new TypeError('[pluxel/core] Plugin facade is already registered')
	instanceState.set(facade, stateOf(provider))
}

/** @internal Create the lifecycle adapter for one already-constructed generation. */
export function getPluginLifecycleAdapter<P extends BasePlugin>(
	plugin: P,
): PluginLifecycleAdapter<PluginContextOf<P>> {
	const state = stateOf(plugin)
	const ctx = state.ctx as PluginContextOf<P>
	const init = (
		plugin as unknown as {
			init?: (signal: AbortSignal) => PluginCleanup | Promise<PluginCleanup>
		}
	).init
	const extended = ctx as unknown as { onError?: (cb: (err: unknown) => void) => unknown }
	const onError = extended.onError
	return {
		init: async (signal) => {
			state.initActive = true
			try {
				await startPluginParts(state.parts, signal)
				if (typeof init === 'function') {
					openConfigUpdateRegistrationWindow(ctx)
					const cleanup = await init.call(plugin, signal)
					await adoptCleanup(ctx, cleanup)
				}
			} finally {
				closeConfigUpdateRegistrationWindow(ctx)
				state.initActive = false
			}
		},
		drain: async () => {
			await Promise.all([closeOwnerInvocations(ctx), closePluginPartInvocations(state.parts)])
			try {
				await ctx.effects.dispose()
			} finally {
				await Promise.all([
					closeConsumerInvocations(ctx),
					closePluginPartConsumerInvocations(state.parts),
				])
			}
		},
		subscribeErrors:
			typeof onError === 'function'
				? (cb) => {
						const off = onError.call(ctx, cb)
						return typeof off === 'function' ? (off as () => void) : undefined
					}
				: undefined,
	}
}
