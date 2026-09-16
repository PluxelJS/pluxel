import type {
	CoreHostConfig,
	PluginConstructor,
	PluginNodeAddress,
	RootContext,
} from '@pluxel/core'
import {
	consumePluginDefinitionCandidate,
	createCoreRootContext,
	requirePluginService,
} from '@pluxel/core/internal'
import { createPluginCatalogSnapshot, type PluginCatalogSnapshot } from './catalog'
import type { PluginApplyReport } from './coordinator'
import { installPluginHostCoordinator } from './install'
import { createMemoryHostState } from './memory-state'
import type { HostStateSnapshot } from './policy'
import { installPluginSources, type PluginSource, type PluginSourceChange } from './sources'
import { openPluginSources, type PluginSourceSession } from './source-session'
import { collectPluginModuleExports } from './module'

type HostBaseOptions = Readonly<{
	/** Explicit definition catalog. A definition is activated only by state.autoStart or startNode. */
	plugins: readonly PluginConstructor[]
	/** Core root settings; omitted values use Core defaults. */
	config?: CoreHostConfig
	/** Initial graph policy; omitted lists are empty. This lightweight host does not persist policy. */
	state?: Partial<HostStateSnapshot>
}>

/** Shared application declaration for explicit plugins and optional dynamic sources. */
export type HostApplication = HostBaseOptions & Readonly<{ sources?: readonly PluginSource[] }>

export type HostOptions = HostBaseOptions &
	(
		| Readonly<{ sources?: never; root?: never; loadModule?: never; onSourceError?: never }>
		| Readonly<{
				/** Application root passed to source discovery. */
				root: string
				sources: readonly PluginSource[]
				/** Owns module resolution and revision identity; return fresh exports after a change. */
				loadModule(path: string): Promise<unknown>
				/** Failed candidates retain the committed catalog. Defaults to the root logger. */
				onSourceError?(error: unknown): void
		  }>
	)

export interface PluginHost {
	readonly ctx: RootContext
	/** Idempotently publishes the initial catalog and reconciles startup policy. */
	start(): Promise<PluginApplyReport>
	catalog(): PluginCatalogSnapshot
	/** Replaces the complete definition catalog, preserving running intent for retained addresses. */
	updateCatalog(plugins: readonly PluginConstructor[]): Promise<PluginApplyReport>
	startNode(address: PluginNodeAddress): Promise<PluginApplyReport>
	stopNode(address: PluginNodeAddress): Promise<PluginApplyReport>
	restartNode(address: PluginNodeAddress): Promise<PluginApplyReport>
	/** Stops admission, drains accepted graph operations, stops generations, and disposes the root. */
	close(): Promise<void>
}

/** Create a Core-only Plugin host. Construction does not start Plugin generations. */
export function createHost(options: HostOptions): PluginHost {
	const state = createMemoryHostState(options.state)
	const fixed = [...options.plugins]
	catalog(1, fixed) // Admit explicit definitions before creating any root resources.
	const ctx = createCoreRootContext(options.config)
	const coordinator = installPluginHostCoordinator(ctx, { state })
	let start: Promise<PluginApplyReport> | undefined
	let closing: Promise<void> | undefined
	let revision = 0
	let sourceSession: PluginSourceSession | undefined
	let modules = new Map<string, readonly PluginConstructor[]>()
	let fixedPlugins: readonly PluginConstructor[] = fixed
	let sourceTail = Promise.resolve()
	const abort = new AbortController()
	if (options.sources) installPluginSources(ctx, { root: options.root, sources: options.sources })
	const combined = (
		entries: ReadonlyMap<string, readonly PluginConstructor[]>,
		explicit = fixedPlugins,
	): readonly PluginConstructor[] => [
		...explicit,
		...[...entries.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.flatMap(([, values]) => values),
	]
	const reportSourceError = (error: unknown): void => {
		try {
			if (options.onSourceError) options.onSourceError(error)
			else ctx.logger.error('Plugin source candidate rejected', { error })
		} catch (observerError) {
			// An application's diagnostic callback cannot poison graph admission or resource cleanup.
			try {
				ctx.logger.error('Plugin source error observer failed', { error: observerError })
			} catch {
				/* Logging is diagnostic only. */
			}
		}
	}
	const applySourceChange = async (change: PluginSourceChange): Promise<void> => {
		await start
		if (closing) return
		const next = new Map(modules)
		if (change.type === 'unlink') next.delete(change.path)
		else next.set(change.path, collectPluginModuleExports(await options.loadModule!(change.path)))
		if (closing) return
		await coordinator.updateCatalog(catalog(++revision, combined(next)))
		modules = next
	}
	const enqueueSourceChange = (change: PluginSourceChange): void => {
		if (closing) return
		sourceTail = sourceTail.then(() => applySourceChange(change)).catch(reportSourceError)
	}
	const assertOpen = (): void => {
		if (closing) throw new Error('[host] host is closed')
	}
	const startHost = (): Promise<PluginApplyReport> => {
		assertOpen()
		return (start ??= (async () => {
			if (options.sources) {
				sourceSession = await openPluginSources({
					root: options.root,
					sources: options.sources,
					signal: abort.signal,
					onChange: enqueueSourceChange,
					onError: reportSourceError,
				})
				for (const path of sourceSession.entries())
					modules.set(path, collectPluginModuleExports(await options.loadModule(path)))
			}
			assertOpen()
			return coordinator.reconcileStartup(catalog(++revision, combined(modules)))
		})())
	}
	return Object.freeze({
		ctx,
		start: startHost,
		catalog: () => coordinator.catalogSnapshot(),
		async updateCatalog(plugins: readonly PluginConstructor[]) {
			assertOpen()
			await startHost()
			assertOpen()
			const next = [...plugins]
			const task = sourceTail.then(async () => {
				assertOpen()
				const report = await coordinator.updateCatalog(catalog(++revision, combined(modules, next)))
				fixedPlugins = next
				return report
			})
			sourceTail = task.then(
				(): void => undefined,
				(): void => undefined,
			)
			return task
		},
		async startNode(address: PluginNodeAddress) {
			assertOpen()
			await startHost()
			assertOpen()
			return coordinator.startNode(address)
		},
		async stopNode(address: PluginNodeAddress) {
			assertOpen()
			await startHost()
			assertOpen()
			return coordinator.stopNode(address)
		},
		async restartNode(address: PluginNodeAddress) {
			assertOpen()
			await startHost()
			assertOpen()
			return coordinator.restartNode(address)
		},
		close(): Promise<void> {
			return (closing ??= (async () => {
				abort.abort()
				const failures: unknown[] = []
				try {
					await start
				} catch {
					/* Startup is reported to its original caller. */
				}
				try {
					await sourceSession?.close()
				} catch (error) {
					failures.push(error)
				}
				try {
					await sourceTail
				} catch (error) {
					failures.push(error)
				}
				await coordinator.dispose()
				try {
					const registry = requirePluginService(ctx)
					const nodes = registry.readCommittedDependencyAdjacency().nodes
					if (nodes.length > 0) {
						const update = registry.beginUpdate({ reason: 'host-close' })
						for (const node of nodes) update.dematerializeNode(node, { cascadeDependents: true })
						const result = await update.commit()
						if (result.ok === false) failures.push(result.err)
						for (const issue of registry.lastCommit?.lifecycleReport.issues ?? [])
							failures.push(issue.error ?? new Error(issue.message))
					}
				} catch (error) {
					failures.push(error)
				}
				try {
					await ctx.effects.dispose()
				} catch (error) {
					failures.push(error)
				}
				if (failures.length > 0) throw new AggregateError(failures, '[host] shutdown failed')
			})())
		},
	})
}

function catalog(revision: number, plugins: readonly PluginConstructor[]): PluginCatalogSnapshot {
	return createPluginCatalogSnapshot(
		revision,
		plugins.map((plugin) => ({ candidate: consumePluginDefinitionCandidate(plugin) })),
	)
}
