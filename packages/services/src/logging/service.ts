import type { PluginNodeAddress, RootContext } from '@pluxel/core'
import {
	defineContextCapability,
	installRootCapability,
	resolveContextCapability,
} from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'
import {
	bindContextRuntimeLogging,
	createContextRuntimeLogging,
	type RuntimeLogging,
	type RuntimeLoggingInput,
} from './logging'
import { normalizePluginLogPolicySnapshot, type PluginLogPolicyStore } from './policy'
import { assertRuntimeLoggingInput } from './validation'

export const Logging = defineContextCapability<RuntimeLogging>('logging.host', {
	access: 'root',
	property: 'logging',
})
export type LoggingOptions = Readonly<{
	/** Borrow one policy store per Host. The factory performs no IO and does not transfer ownership. */
	policyStore?: (root: RootContext) => PluginLogPolicyStore
}>
declare module '@pluxel/core' {
	interface RootContextServices {
		readonly logging: RuntimeLogging
	}
}

/** Install one process logging owner for this Host; declaration evaluation performs no IO. */
export function logging(input: RuntimeLoggingInput, options: LoggingOptions = {}) {
	assertRuntimeLoggingInput(input)
	const policyStore = options.policyStore
	if (policyStore !== undefined && typeof policyStore !== 'function')
		throw new TypeError('[services.logging] policyStore must be a synchronous root factory')
	const plan: RuntimeLoggingInput = {
		root: {
			...input.root,
			...(input.root.debugTopics ? { debugTopics: [...input.root.debugTopics] } : {}),
			...(input.root.initialPluginPolicy
				? { initialPluginPolicy: normalizePluginLogPolicySnapshot(input.root.initialPluginPolicy) }
				: {}),
		},
		sinks: Object.fromEntries(
			Object.entries(input.sinks).map(([name, sink]) => [
				name,
				sink.kind === 'store'
					? {
							...sink,
							...(sink.caps ? { caps: { ...sink.caps } } : {}),
							...(sink.hiddenKeys ? { hiddenKeys: [...sink.hiddenKeys] } : {}),
							...(sink.redactKeys ? { redactKeys: [...sink.redactKeys] } : {}),
						}
					: { ...sink },
			]),
		),
		routes: {
			runtime: input.routes.runtime.map((binding) => ({ ...binding })),
			plugins: input.routes.plugins.map((binding) => ({ ...binding })),
			debug: input.routes.debug.map((binding) => ({ ...binding })),
			meta: input.routes.meta.map((binding) => ({ ...binding })),
		},
	}
	return defineHostService({
		name: 'Logging',
		capabilities: [
			installRootCapability(Logging, {
				property: 'logging',
				create: (ctx) => createContextRuntimeLogging(ctx, plan),
			}),
		],
		async prepare({ ctx, effects }) {
			const manager = resolveContextCapability(ctx, Logging)
			effects.defer(() => manager.dispose(), { tag: 'HostLogging' })
			const store = policyStore?.(ctx)
			if (
				policyStore &&
				(!store || typeof store.load !== 'function' || typeof store.save !== 'function')
			)
				throw new TypeError('[services.logging] policyStore factory must return a policy store')
			if (manager.state === 'created') await manager.install()
			const unbind = bindContextRuntimeLogging(ctx, manager)
			effects.defer(unbind, { tag: 'HostLoggingBinding' })
			await manager.initializePolicy(store)
		},
		removeNodeMetadata(ctx, node) {
			return clearLoggingPolicy(resolveContextCapability(ctx, Logging), node)
		},
	})
}
async function clearLoggingPolicy(manager: RuntimeLogging, node: PluginNodeAddress): Promise<void> {
	const mutation = manager.policy.clearPluginLevel(node)
	if (mutation.persistence === 'failed') manager.policy.replace(manager.policy.snapshot())
	await manager.policy.flush()
	if (manager.policy.persistence === 'failed')
		throw manager.policy.lastPersistenceError ?? new Error('logging policy persistence failed')
}
