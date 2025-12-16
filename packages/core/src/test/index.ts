import '../reflection'

import '../services'

import { Context } from '@pluxel/context'
import { checkPluginDecorator } from '../plugins/PluginDecorator'
import type { PluginConstructor, PluginIdentifier } from '../plugins/types'
import type { CommitSummary, PluginService } from '../plugins/service/PluginService'

export * from '../index'
export { EffectScopeService } from '../services/EffectScopeService'
export { EventsService } from '../services/EventsService'
export { LoggerService } from '../services/LoggerService'

export type PluginTestHost = {
	ctx: Context
	registry: PluginService
	register: (Plugin: PluginConstructor, opts?: { provideBase?: boolean }) => void
	registerAll: (...plugins: PluginConstructor[]) => void
	fork: PluginService['fork']
	registerFork: PluginService['registerFork']
	getFork: PluginService['getFork']
	listForks: PluginService['listForks']
	isRunning: PluginService['isRunning']
	optional: PluginService['optional']
	unregister: (id: PluginIdentifier) => void
	reload: (id: PluginIdentifier, next?: PluginConstructor) => void
	commitResult: PluginService['commit']
	commit: () => Promise<CommitSummary>
	commitStrict: () => Promise<CommitSummary>
	start: <T extends PluginConstructor>(Plugin: T, opts?: { provideBase?: boolean }) => Promise<InstanceType<T>>
	get: <T extends PluginIdentifier>(id: T) => InstanceType<T> | undefined
	getOrThrow: <T extends PluginIdentifier>(id: T) => InstanceType<T>
	dispose: () => Promise<void>
}

export function createPluginTestHost(config: Context.Config = {}): PluginTestHost {
	const ctx = new Context({ name: 'test', ...config })
	const registry = ctx.registry as PluginService

	const host: PluginTestHost = {
		ctx,
		registry,

		register: (Plugin, opts) => registry.pluginRegistry.registerPlugin(Plugin, opts),
		registerAll: (...plugins) => {
			for (const Plugin of plugins) registry.pluginRegistry.registerPlugin(Plugin)
		},
		fork: registry.fork.bind(registry),
		registerFork: registry.registerFork.bind(registry),
		getFork: registry.getFork.bind(registry),
		listForks: registry.listForks.bind(registry),
		isRunning: registry.isRunning.bind(registry),
		optional: registry.optional.bind(registry) as any,
		unregister: (id) => registry.pluginRegistry.unregisterPlugin(id),
		reload: (id, next) => registry.pluginRegistry.reloadPlugin(id, next),

		commitResult: registry.commit.bind(registry) as PluginService['commit'],
		commit: async () => {
			const result = await registry.commit()
			if (!result.ok) {
				throw result.err instanceof Error ? result.err : new Error(String(result.err))
			}
			const summary = registry.lastCommit
			if (!summary) throw new Error('commit succeeded but lastCommit is missing')
			return summary
		},
		commitStrict: async () => {
			const summary = await host.commit()
			if (summary.failed.length) {
				throw new Error(
					`Some plugins failed to start: ${summary.failed.map(String).join(', ')}`,
				)
			}
			return summary
		},
		start: async (Plugin, opts) => {
			registry.pluginRegistry.registerPlugin(Plugin, opts)
			await host.commitStrict()
			return host.getOrThrow(Plugin)
			},

			get: (id) => {
				return registry.getInstance(id as any) as any
			},
		getOrThrow: (id) => {
			const instance = host.get(id)
			if (!instance) {
				throw new Error(`Plugin instance not found (did you forget to register+commit?): ${String(id)}`)
			}
			return instance
		},

			dispose: async () => {
				try {
					// Ensure any uncommitted draft ops don't leak across tests.
					registry.pluginRegistry.resetDraft()

					const container = registry.pluginRegistry.lastContainer
					if (container) {
						const ids = [...container.services.keys()].filter(
							(id): id is PluginConstructor => typeof id === 'function' && checkPluginDecorator(id),
						)
						for (const id of ids) registry.pluginRegistry.unregisterPlugin(id)
						await host.commit()
					}
				} finally {
					registry.pluginRegistry.resetDraft()
					;(ctx as any).disposeAll?.()
				}
			},
		}

	return host
}

export async function withPluginTestHost<T>(
	fn: (host: PluginTestHost) => Promise<T> | T,
	config: Context.Config = {},
): Promise<T> {
	const host = createPluginTestHost(config)
	try {
		return await fn(host)
	} finally {
		await host.dispose()
	}
}

export type TestContext = {
	ctx: Context
	dispose: () => void
}

export function createTestContext(config: Context.Config = {}): TestContext {
	const ctx = new Context({ name: 'test', ...config })
	return {
		ctx,
		dispose: () => {
			// Best-effort cleanup; keeps tests isolated even if they didn't use host.
			;(ctx as any).registry?.pluginRegistry?.resetDraft?.()
			;(ctx as any).disposeAll?.()
			;(ctx as any).registry?.pluginRegistry?.resetDraft?.()
		},
	}
}

export async function withTestContext<T>(
	fn: (ctx: Context) => Promise<T> | T,
	config: Context.Config = {},
): Promise<T> {
	const t = createTestContext(config)
	try {
		return await fn(t.ctx)
	} finally {
		t.dispose()
	}
}
