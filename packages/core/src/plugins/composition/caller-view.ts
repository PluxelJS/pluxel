import type { Context } from '@pluxel/context'
import { enterOwnerInvocation } from '../../internal/owner-invocations'
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

function withProviderAdmission<T>(provider: Context, run: () => T): T {
	const lease = enterOwnerInvocation(provider)
	try {
		const result = run()
		if (
			result &&
			(typeof result === 'object' || typeof result === 'function') &&
			typeof (result as { then?: unknown }).then === 'function'
		) {
			return Promise.resolve(result).finally(() => lease.dispose()) as T
		}
		lease.dispose()
		return result
	} catch (error) {
		lease.dispose()
		throw error
	}
}

function createCallerContext(provider: Context, consumer: Context): Context {
	const view = Object.create(provider) as Context
	inheritPinnedPluginInfo(view, provider)
	Object.defineProperty(view, 'caller', {
		value: consumer,
		writable: false,
		enumerable: false,
		configurable: false,
	})
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

function findPropertyDescriptor(
	target: object,
	property: PropertyKey,
): PropertyDescriptor | undefined {
	return findPropertyDescriptorEntry(target, property)?.descriptor
}

type PropertyDescriptorEntry = {
	readonly owner: object
	readonly descriptor: PropertyDescriptor
}

function findPropertyDescriptorEntry(
	target: object,
	property: PropertyKey,
): PropertyDescriptorEntry | undefined {
	let current: object | null = target
	while (current) {
		const descriptor = Reflect.getOwnPropertyDescriptor(current, property)
		if (descriptor) return { owner: current, descriptor }
		current = Reflect.getPrototypeOf(current)
	}
	return undefined
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
	property: PropertyKey,
	value: unknown,
): boolean {
	const descriptor = findPropertyDescriptor(target, property)
	if (descriptor && !('value' in descriptor)) {
		if (!descriptor.set) return false
		Reflect.apply(descriptor.set, accessorReceiver, [value])
		return true
	}
	return Reflect.set(target, property, value, target)
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
	method: Function,
	args: readonly unknown[],
): unknown {
	const lease = enterOwnerInvocation(providerContext)
	let active = true
	let callFacade!: T
	const fallback = () => stableFacade
	const handler: ProxyHandler<T> = {
		get(innerTarget, property, receiver) {
			if (!active) return Reflect.get(fallback(), property, fallback())
			if (property === 'ctx') return callerContext
			const entry = findPropertyDescriptorEntry(innerTarget, property)
			const value = Reflect.get(innerTarget, property, receiver)
			assertSupportedCallableProperty(innerTarget, property, entry, value)
			return bindCallerCapability(value, consumer)
		},
		set(innerTarget, property, value) {
			if (!active) return Reflect.set(fallback(), property, value, fallback())
			assertMutableAuthorField(property)
			return writeProviderProperty(innerTarget, callFacade, property, value)
		},
		defineProperty: rejectDefineProperty,
		deleteProperty: rejectDeleteProperty,
		setPrototypeOf: rejectPrototypeMutation,
		preventExtensions: rejectPreventExtensions,
	}
	callFacade = new Proxy(target, handler)
	registerPluginGenerationFacade(callFacade, target)

	const finish = () => {
		active = false
		lease.dispose()
	}
	try {
		const result = Reflect.apply(method, callFacade, args)
		if (
			result &&
			(typeof result === 'object' || typeof result === 'function') &&
			typeof (result as { then?: unknown }).then === 'function'
		) {
			return Promise.resolve(result)
				.then((value) => (value === callFacade ? stableFacade : value))
				.finally(finish)
		}
		finish()
		return result === callFacade ? stableFacade : result
	} catch (error) {
		finish()
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
	const methods = new Map<PropertyKey, MethodCacheEntry>()
	let facade!: T
	const handler: ProxyHandler<T> = {
		get(target, property, receiver) {
			if (property === 'ctx') {
				return withProviderAdmission(providerContext, () => callerContext)
			}
			const entry = findPropertyDescriptorEntry(target, property)
			const descriptor = entry?.descriptor
			const rawValue =
				descriptor && !('value' in descriptor) && descriptor.get
					? invokeProviderMethod(
							target,
							facade,
							providerContext,
							callerContext,
							consumer,
							descriptor.get,
							[],
						)
					: withProviderAdmission(providerContext, () => Reflect.get(target, property, receiver))
			assertSupportedCallableProperty(target, property, entry, rawValue)
			const value = bindCallerCapability(rawValue, consumer)
			if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value
			if (typeof value !== 'function') return value
			const existing = methods.get(property)
			if (existing?.source === value) return existing.bound
			const bound = (...args: unknown[]) =>
				invokeProviderMethod(target, facade, providerContext, callerContext, consumer, value, args)
			methods.set(property, { source: value, bound })
			return bound
		},
		set(target, property, value) {
			assertMutableAuthorField(property)
			const descriptor = findPropertyDescriptor(target, property)
			if (descriptor && !('value' in descriptor) && descriptor.set) {
				invokeProviderMethod(
					target,
					facade,
					providerContext,
					callerContext,
					consumer,
					descriptor.set,
					[value],
				)
				return true
			}
			return withProviderAdmission(providerContext, () =>
				writeProviderProperty(target, facade, property, value),
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
