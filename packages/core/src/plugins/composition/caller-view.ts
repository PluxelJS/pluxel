import { createCallerContextView, type Context } from '../../context/Context'
import {
	admitOwnerInvocation,
	assertOwnerInvocationOpen,
	releaseOwnerInvocation,
	type OwnerInvocationAdmission,
} from '../../internal/owner-invocations'
import {
	BasePlugin,
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

const viewsByConsumer = new WeakMap<Context, WeakMap<BasePlugin, BasePlugin>>()

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

type PropertyDescriptorEntry = {
	readonly owner: object
	readonly descriptor: PropertyDescriptor
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
	// The resolver already exhausted the complete ordinary Plugin prototype chain.
	// Avoid a second lookup that could only reproduce the same `undefined` result.
	if (!entry) return undefined
	const descriptor = entry.descriptor
	if ('value' in descriptor) return descriptor.value
	return descriptor.get ? Reflect.apply(descriptor.get, receiver, []) : undefined
}

function rejectDefineProperty(): never {
	throw new TypeError('[pluxel/core] Plugin caller facade does not allow defineProperty')
}

function rejectDeleteProperty(): never {
	throw new TypeError('[pluxel/core] Plugin caller facade does not allow deleteProperty')
}

function rejectPrototypeMutation(): never {
	throw new TypeError('[pluxel/core] Plugin caller facade does not allow prototype mutation')
}

function rejectPreventExtensions(): never {
	throw new TypeError('[pluxel/core] Plugin caller facade cannot be sealed or frozen')
}

class ProviderCallReceiver<T extends BasePlugin> implements ProxyHandler<T> {
	active = true
	facade!: T

	constructor(
		readonly stableFacade: T,
		private readonly callerContext: Context,
		private readonly consumer: Context,
		private readonly descriptors: PropertyDescriptorResolver,
		private readonly admission: OwnerInvocationAdmission,
	) {}

	get(target: T, property: PropertyKey, receiver: T): unknown {
		if (!this.active) return Reflect.get(this.stableFacade, property, this.stableFacade)
		if (property === 'ctx') return this.callerContext
		const entry = this.descriptors.find(property)
		const value = readProviderProperty(receiver, entry)
		assertSupportedCallableProperty(target, property, entry, value)
		return bindCallerCapability(value, this.consumer)
	}

	set(target: T, property: PropertyKey, value: unknown): boolean {
		if (!this.active) return Reflect.set(this.stableFacade, property, value, this.stableFacade)
		assertMutableAuthorField(property)
		return writeProviderProperty(target, this.facade, this.descriptors, property, value)
	}

	defineProperty(): never {
		return rejectDefineProperty()
	}

	deleteProperty(): never {
		return rejectDeleteProperty()
	}

	setPrototypeOf(): never {
		return rejectPrototypeMutation()
	}

	preventExtensions(): never {
		return rejectPreventExtensions()
	}

	finish(): void {
		if (!this.active) return
		this.active = false
		releaseOwnerInvocation(this.admission)
	}
}

async function settleProviderInvocation<T extends BasePlugin>(
	result: PromiseLike<unknown>,
	receiver: ProviderCallReceiver<T>,
): Promise<unknown> {
	try {
		const value = await result
		return value === receiver.facade ? receiver.stableFacade : value
	} finally {
		receiver.finish()
	}
}

/**
 * Invoke one method with a call-scoped receiver covered by the already acquired lease.
 * Nested `this` reads/writes must not attempt a second admission after teardown has begun:
 * the outer lease is precisely the authority that lets this accepted async call settle.
 */
function invokeProviderMethod<T extends BasePlugin>(
	target: T,
	stableFacade: T,
	providerContext: Context,
	callerContext: Context,
	consumer: Context,
	descriptors: PropertyDescriptorResolver,
	method: Function,
	args: readonly unknown[],
): unknown {
	const admission: OwnerInvocationAdmission = admitOwnerInvocation(providerContext)
	const receiver = new ProviderCallReceiver(
		stableFacade,
		callerContext,
		consumer,
		descriptors,
		admission,
	)
	const callFacade = new Proxy(target, receiver)
	receiver.facade = callFacade
	registerPluginGenerationFacade(callFacade, target)

	try {
		const result = Reflect.apply(method, callFacade, args)
		if (
			result &&
			(typeof result === 'object' || typeof result === 'function') &&
			typeof (result as { then?: unknown }).then === 'function'
		) {
			return settleProviderInvocation(Promise.resolve(result), receiver)
		}
		receiver.finish()
		return result === callFacade ? stableFacade : result
	} catch (error) {
		receiver.finish()
		throw error
	}
}

/**
 * @internal Live facade for one consumer-generation -> provider-generation edge.
 * The cache is generation-bounded because both keys are generation objects.
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
	const methods = new Map<PropertyKey, MethodCacheEntry>()
	let facade!: T
	const handler: ProxyHandler<T> = {
		get(target, property) {
			if (property === 'ctx') {
				assertOwnerInvocationOpen(providerContext)
				return callerContext
			}
			const cachedMethod = methods.get(property)
			if (cachedMethod && !Reflect.getOwnPropertyDescriptor(target, property)) {
				assertOwnerInvocationOpen(providerContext)
				return cachedMethod.bound
			}
			const entry = descriptors.find(property)
			const descriptor = entry?.descriptor
			const rawValue =
				descriptor && !('value' in descriptor) && descriptor.get
					? invokeProviderMethod(
							target,
							facade,
							providerContext,
							callerContext,
							consumer,
							descriptors,
							descriptor.get,
							[],
						)
					: descriptor && 'value' in descriptor && typeof descriptor.value === 'function'
						? (assertOwnerInvocationOpen(providerContext), descriptor.value)
						: retainProviderAdmission(providerContext, readProviderProperty(facade, entry))
			assertSupportedCallableProperty(target, property, entry, rawValue)
			const value = bindCallerCapability(rawValue, consumer)
			if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value
			if (typeof value !== 'function') return value
			if (cachedMethod?.source === value) return cachedMethod.bound
			const bound = (...args: unknown[]) =>
				invokeProviderMethod(
					target,
					facade,
					providerContext,
					callerContext,
					consumer,
					descriptors,
					value,
					args,
				)
			methods.set(property, { source: value, bound })
			return bound
		},
		set(target, property, value) {
			assertMutableAuthorField(property)
			const descriptor = descriptors.find(property)?.descriptor
			if (descriptor && !('value' in descriptor) && descriptor.set) {
				invokeProviderMethod(
					target,
					facade,
					providerContext,
					callerContext,
					consumer,
					descriptors,
					descriptor.set,
					[value],
				)
				return true
			}
			return writeAdmittedProviderProperty(
				providerContext,
				target,
				facade,
				descriptors,
				property,
				value,
			)
		},
		defineProperty: rejectDefineProperty,
		deleteProperty: rejectDeleteProperty,
		setPrototypeOf: rejectPrototypeMutation,
		preventExtensions: rejectPreventExtensions,
	}
	facade = new Proxy(provider, handler)
	registerPluginGenerationFacade(facade, provider)
	byProvider.set(provider, facade)
	return facade
}
