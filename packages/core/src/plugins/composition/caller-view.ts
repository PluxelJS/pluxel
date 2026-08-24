import type { Context } from '../../context/Context'
import { createCallerContextView } from '../../context/context-factory'
import {
	admitOwnerInvocation,
	assertOwnerInvocationOpen,
	releaseOwnerInvocation,
	type OwnerInvocationAdmission,
} from '../../internal/owner-invocations'
import {
	BasePlugin,
	getPluginGenerationCallerSurface,
	getPluginGenerationContext,
	registerPluginGenerationFacade,
} from './BasePlugin'
import { CALLER_CONTEXT_BIND } from './symbols'
import { inheritPinnedPluginInfo } from './context-projection'

type BoundCapability = {
	[CALLER_CONTEXT_BIND]?: (caller: Context) => unknown
}

type MethodCacheEntry = {
	readonly source: Function
	readonly bound: (...args: unknown[]) => unknown
}

type PropertyDescriptorEntry = {
	readonly owner: object
	readonly descriptor: PropertyDescriptor
}

type StableFacadeState<T extends BasePlugin> = {
	readonly kind: 'stable'
	readonly target: T
	readonly facade: T
	readonly providerContext: Context
	readonly callerContext: Context
	readonly consumer: Context
	readonly descriptors: PropertyDescriptorResolver
	readonly methods: Map<PropertyKey, MethodCacheEntry>
	readonly callPrototype: object
}

type CallFacadeState<T extends BasePlugin> = {
	readonly kind: 'call'
	readonly stable: StableFacadeState<T>
	readonly facade: T
	readonly admission: OwnerInvocationAdmission
	active: boolean
}

type FacadeState<T extends BasePlugin = BasePlugin> = StableFacadeState<T> | CallFacadeState<T>

const viewsByConsumer = new WeakMap<Context, WeakMap<BasePlugin, BasePlugin>>()
const facadeStates = new WeakMap<BasePlugin, FacadeState>()

function retainProviderAdmission<T>(provider: Context, value: T): T {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
		assertOwnerInvocationOpen(provider)
		return value
	}

	const admission = admitOwnerInvocation(provider)
	try {
		if (typeof (value as { then?: unknown }).then === 'function') {
			return Promise.resolve(value).finally(() => releaseOwnerInvocation(admission)) as T
		}
		releaseOwnerInvocation(admission)
		return value
	} catch (error) {
		releaseOwnerInvocation(admission)
		throw error
	}
}

function createCallerContext(provider: Context, consumer: Context): Context {
	const view = createCallerContextView(provider, consumer)
	inheritPinnedPluginInfo(view, provider)
	return view
}

function bindCallerCapability(value: unknown, consumer: Context): unknown {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value
	const bind = (value as BoundCapability)[CALLER_CONTEXT_BIND]
	return typeof bind === 'function' ? bind.call(value, consumer) : value
}

function assertMutableAuthorField(property: PropertyKey): void {
	if (property === 'ctx' || typeof property === 'symbol') {
		throw new TypeError('[pluxel/core] Plugin caller internal state is read-only')
	}
}

class PropertyDescriptorResolver {
	private readonly prototypeEntries = new Map<PropertyKey, PropertyDescriptorEntry | undefined>()

	constructor(private readonly target: object) {}

	find(property: PropertyKey): PropertyDescriptorEntry | undefined {
		const ownDescriptor = Reflect.getOwnPropertyDescriptor(this.target, property)
		if (ownDescriptor) return { owner: this.target, descriptor: ownDescriptor }
		if (this.prototypeEntries.has(property)) return this.prototypeEntries.get(property)

		let current = Reflect.getPrototypeOf(this.target)
		while (current) {
			const descriptor = Reflect.getOwnPropertyDescriptor(current, property)
			if (descriptor) {
				const entry = { owner: current, descriptor }
				this.prototypeEntries.set(property, entry)
				return entry
			}
			current = Reflect.getPrototypeOf(current)
		}
		this.prototypeEntries.set(property, undefined)
		return undefined
	}
}

function rejectUnsupportedCallableProperty(property: PropertyKey): never {
	throw new TypeError(
		`[pluxel/core] plugin_caller_view_callable_field_unsupported: Plugin dependency callable ${String(property)} must be a prototype method; function-valued instance fields and accessor results cannot preserve caller identity`,
	)
}

function assertSupportedCallableProperty(
	target: object,
	property: PropertyKey,
	entry: PropertyDescriptorEntry | undefined,
	value: unknown,
): void {
	if (typeof value !== 'function') return
	if (!entry || entry.owner === target || !('value' in entry.descriptor)) {
		rejectUnsupportedCallableProperty(property)
	}
}

function writeProviderProperty<T extends BasePlugin>(
	target: T,
	accessorReceiver: T,
	descriptors: PropertyDescriptorResolver,
	property: PropertyKey,
	value: unknown,
): boolean {
	const descriptor = descriptors.find(property)?.descriptor
	if (descriptor && !('value' in descriptor)) {
		if (!descriptor.set) return false
		Reflect.apply(descriptor.set, accessorReceiver, [value])
		return true
	}
	return Reflect.set(target, property, value, target)
}

function writeAdmittedProviderProperty<T extends BasePlugin>(
	providerContext: Context,
	target: T,
	accessorReceiver: T,
	descriptors: PropertyDescriptorResolver,
	property: PropertyKey,
	value: unknown,
): boolean {
	const admission = admitOwnerInvocation(providerContext)
	try {
		return writeProviderProperty(target, accessorReceiver, descriptors, property, value)
	} finally {
		releaseOwnerInvocation(admission)
	}
}

function readProviderProperty<T extends BasePlugin>(
	receiver: T,
	entry: PropertyDescriptorEntry | undefined,
): unknown {
	if (!entry) return undefined
	const descriptor = entry.descriptor
	if ('value' in descriptor) return descriptor.value
	return descriptor.get ? Reflect.apply(descriptor.get, receiver, []) : undefined
}

function requireFacadeState<T extends BasePlugin>(facade: T): FacadeState<T> {
	const state = facadeStates.get(facade) as FacadeState<T> | undefined
	if (!state) throw new TypeError('[pluxel/core] Invalid Plugin caller facade')
	return state
}

function readFacadeProperty<T extends BasePlugin>(
	state: FacadeState<T>,
	property: PropertyKey,
): unknown {
	if (state.kind === 'call' && !state.active) {
		return readFacadeProperty(state.stable, property)
	}
	const stable = state.kind === 'stable' ? state : state.stable
	if (property === 'ctx') {
		if (state.kind === 'stable') assertOwnerInvocationOpen(stable.providerContext)
		return stable.callerContext
	}

	const entry = stable.descriptors.find(property)
	const descriptor = entry?.descriptor
	if (state.kind === 'call') {
		const value = readProviderProperty(state.facade, entry)
		assertSupportedCallableProperty(stable.target, property, entry, value)
		return bindCallerCapability(value, stable.consumer)
	}

	const rawValue =
		descriptor && !('value' in descriptor) && descriptor.get
			? invokeProviderMethod(stable, descriptor.get, [])
			: descriptor && 'value' in descriptor && typeof descriptor.value === 'function'
				? (assertOwnerInvocationOpen(stable.providerContext), descriptor.value)
				: retainProviderAdmission(
						stable.providerContext,
						readProviderProperty(stable.facade, entry),
					)
	assertSupportedCallableProperty(stable.target, property, entry, rawValue)
	const value = bindCallerCapability(rawValue, stable.consumer)
	if (typeof value !== 'function') return value
	const cached = stable.methods.get(property)
	if (cached?.source === value) return cached.bound
	const bound = (...args: unknown[]) => invokeProviderMethod(stable, value, args)
	stable.methods.set(property, { source: value, bound })
	return bound
}

function writeFacadeProperty<T extends BasePlugin>(
	state: FacadeState<T>,
	property: PropertyKey,
	value: unknown,
): boolean {
	if (state.kind === 'call' && !state.active) {
		return writeFacadeProperty(state.stable, property, value)
	}
	assertMutableAuthorField(property)
	const stable = state.kind === 'stable' ? state : state.stable
	const descriptor = stable.descriptors.find(property)?.descriptor
	if (descriptor && !('value' in descriptor) && descriptor.set) {
		if (state.kind === 'stable') invokeProviderMethod(stable, descriptor.set, [value])
		else Reflect.apply(descriptor.set, state.facade, [value])
		return true
	}
	return state.kind === 'stable'
		? writeAdmittedProviderProperty(
				stable.providerContext,
				stable.target,
				stable.facade,
				stable.descriptors,
				property,
				value,
			)
		: writeProviderProperty(stable.target, state.facade, stable.descriptors, property, value)
}

function projectedDescriptor<T extends BasePlugin>(
	property: PropertyKey,
	enumerable: boolean,
): PropertyDescriptor {
	return {
		get(this: T) {
			return readFacadeProperty(requireFacadeState(this), property)
		},
		set(this: T, value: unknown) {
			if (!writeFacadeProperty(requireFacadeState(this), property, value)) {
				throw new TypeError(`[pluxel/core] Plugin caller property ${String(property)} is read-only`)
			}
		},
		enumerable,
		configurable: false,
	}
}

function compileFacadeShape<T extends BasePlugin>(
	target: T,
	descriptors: PropertyDescriptorResolver,
	properties: readonly PropertyKey[],
): { readonly facade: T; readonly callPrototype: object } {
	const providerPrototype = Object.getPrototypeOf(target) as object
	const callPrototype = Object.create(providerPrototype) as object
	const facade = Object.create(providerPrototype) as T
	for (const property of properties) {
		const enumerable = descriptors.find(property)?.descriptor.enumerable ?? false
		const descriptor = projectedDescriptor<T>(property, enumerable)
		Object.defineProperty(callPrototype, property, descriptor)
		Object.defineProperty(facade, property, descriptor)
	}
	Object.preventExtensions(callPrototype)
	return { facade, callPrototype }
}

function finishCall<T extends BasePlugin>(state: CallFacadeState<T>): void {
	if (!state.active) return
	state.active = false
	releaseOwnerInvocation(state.admission)
}

async function settleProviderInvocation<T extends BasePlugin>(
	result: PromiseLike<unknown>,
	state: CallFacadeState<T>,
): Promise<unknown> {
	try {
		const value = await result
		return value === state.facade ? state.stable.facade : value
	} finally {
		finishCall(state)
	}
}

/** Invoke one method with a fresh, ordinary receiver covered by one owner admission lease. */
function invokeProviderMethod<T extends BasePlugin>(
	stable: StableFacadeState<T>,
	method: Function,
	args: readonly unknown[],
): unknown {
	const admission = admitOwnerInvocation(stable.providerContext)
	const facade = Object.create(stable.callPrototype) as T
	const state: CallFacadeState<T> = {
		kind: 'call',
		stable,
		facade,
		admission,
		active: true,
	}
	facadeStates.set(facade, state)
	registerPluginGenerationFacade(facade, stable.target)
	Object.preventExtensions(facade)

	try {
		const result = Reflect.apply(method, facade, args)
		if (
			result &&
			(typeof result === 'object' || typeof result === 'function') &&
			typeof (result as { then?: unknown }).then === 'function'
		) {
			return settleProviderInvocation(Promise.resolve(result), state)
		}
		finishCall(state)
		return result === facade ? stable.facade : result
	} catch (error) {
		finishCall(state)
		throw error
	}
}

/**
 * @internal Live, proxy-free facade for one consumer-generation -> provider-generation edge.
 * The provider's construction-time public shape is compiled once into ordinary accessors.
 */
export function createCallerGenerationView<T extends BasePlugin>(
	provider: T,
	consumer: Context,
): T {
	let byProvider = viewsByConsumer.get(consumer)
	if (!byProvider) {
		byProvider = new WeakMap()
		viewsByConsumer.set(consumer, byProvider)
	}
	const cached = byProvider.get(provider)
	if (cached) return cached as T

	const providerContext = getPluginGenerationContext(provider)
	const callerContext = createCallerContext(providerContext, consumer)
	const descriptors = new PropertyDescriptorResolver(provider)
	const shape = compileFacadeShape(
		provider,
		descriptors,
		getPluginGenerationCallerSurface(provider),
	)
	const state: StableFacadeState<T> = {
		kind: 'stable',
		target: provider,
		facade: shape.facade,
		providerContext,
		callerContext,
		consumer,
		descriptors,
		methods: new Map(),
		callPrototype: shape.callPrototype,
	}
	facadeStates.set(shape.facade, state)
	registerPluginGenerationFacade(shape.facade, provider)
	Object.preventExtensions(shape.facade)
	byProvider.set(provider, shape.facade)
	return shape.facade
}
