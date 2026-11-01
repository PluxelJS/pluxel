import { defineContextCapability } from '@pluxel/context'
import type { RootContext } from '../context/Context'
import type { PluginNodeAddress } from '../plugins/runtime/identity'
import { requireTinyBaseHost } from '../internal/storage'
import {
	bindContextRuntimeLogging,
	type RuntimeLogging,
	type RuntimeLoggingOptions,
} from './logging'
import type { PluginLogPolicyStore } from './policy'
import { assertRuntimeLoggingOptions } from './validation'
import { createPluginLogPolicyStore } from './storage'

/** The root's fixed logging capability; Plugins retain only their scoped ContextLogger. */
export const Logging = defineContextCapability<RuntimeLogging>('core.logging', {
	access: 'root',
	property: 'logging',
})

export type LoggingOptions = Readonly<
	RuntimeLoggingOptions & {
		/** Borrow a policy store instead of Core documents. This factory performs no IO. */
		policyStore?: (root: RootContext) => PluginLogPolicyStore
	}
>

const bindings = new WeakMap<RuntimeLogging, { root: RootContext; unbind(): void }>()

/** @internal Validate only Pluxel's independent options, never the upstream Config schema. */
export function assertLoggingOptions(options: unknown): asserts options is LoggingOptions {
	if (!options || typeof options !== 'object' || Array.isArray(options))
		throw new TypeError('[core.logtape] options must be an object')
	const { policyStore, ...runtimeOptions } = options as LoggingOptions
	assertRuntimeLoggingOptions(runtimeOptions)
	if (policyStore !== undefined && typeof policyStore !== 'function')
		throw new TypeError('[core.logtape] policyStore must be a synchronous root factory')
}

/** @internal Core/Host awaits this before service preparation and Plugin admission. */
export async function prepareContextRuntimeLogging(
	root: RootContext,
	manager: RuntimeLogging,
	options: LoggingOptions = {},
): Promise<void> {
	assertLoggingOptions(options)
	if (bindings.has(manager)) throw new Error('Context logging is already prepared')
	try {
		const store = options.policyStore
			? options.policyStore(root)
			: createPluginLogPolicyStore(requireTinyBaseHost(root).documents('logging'))
		if (!store || typeof store.load !== 'function' || typeof store.save !== 'function')
			throw new TypeError('[core.logtape] policyStore factory must return a policy store')
		await manager.install()
		bindings.set(manager, { root, unbind: bindContextRuntimeLogging(root, manager) })
		await manager.initializePolicy(store)
	} catch (error) {
		const [cleanup] = await Promise.allSettled([disposeContextRuntimeLogging(root, manager)])
		if (cleanup.status === 'rejected')
			throw new AggregateError([error, cleanup.reason], 'Logging preparation and cleanup failed', {
				cause: error,
			})
		throw error
	}
}

/** @internal Final logging stage, after Plugin and service teardown and before storage finalization. */
export async function disposeContextRuntimeLogging(
	root: RootContext,
	manager: RuntimeLogging,
): Promise<void> {
	const binding = bindings.get(manager)
	if (binding) {
		if (binding.root !== root) throw new Error('Cannot dispose another Context logging owner')
		binding.unbind()
		bindings.delete(manager)
	}
	await manager.dispose()
}

/** @internal Host calls this under its metadata mutation gate before removing a fork. */
export async function clearLoggingPolicy(
	manager: RuntimeLogging,
	node: PluginNodeAddress,
): Promise<void> {
	const mutation = manager.policy.clearPluginLevel(node)
	if (mutation.persistence === 'failed') manager.policy.replace(manager.policy.snapshot())
	await manager.policy.flush()
	if (manager.policy.persistence === 'failed')
		throw manager.policy.lastPersistenceError ?? new Error('logging policy persistence failed')
}
