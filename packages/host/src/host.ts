import { validateInputBindingCandidates } from './input-bindings'
import {
	HostVaultBindings,
	type HostVaultBindingRecord,
	type HostEnvironmentBinding,
	type HostFileBinding,
} from './bindings'
import { readHostCatalogProvenance } from './catalog-provenance'
import { readHostPluginStatusOverview, type HostPluginStatusOverview } from './status'
import { ensureFork, removeFork, type ForkEnsureResult, type ForkRemoveResult } from './forks'
import { hostStatePatch } from './state'
import {
	pluginConfigGet,
	pluginConfigValidate,
	pluginConfigPatch,
	pluginConfigReset,
	type HostPluginConfig,
} from './config'
import type {
	CoreHostConfig,
	Context,
	ContextServices,
	PluginConstructor,
	PluginNodeAddress,
	PluginDefinitionAddress,
	RootContext,
} from '@pluxel/core'
import {
	closeOwnerInvocations,
	consumePluginDefinitionCandidate,
	requireConfigService,
	requirePluginService,
} from '@pluxel/core/internal'
import {
	createCoreContextHost,
	type RootContextProjection,
	type ContextCapabilityInstallation,
	type ValidateContextInstallations,
} from '@pluxel/core/host'
import {
	planHostServices,
	prepareHostServices,
	createHostServiceLifecycle,
	type HostService,
} from './services'
import { createPluginCatalogSnapshot, type PluginCatalogSnapshot } from './catalog'
import type { PluginApplyReport } from './coordinator'
import { installPluginHostCoordinator, requirePluginHostCoordinator } from './install'
import { HostStateStore, resolveHostStateInitial, type HostStateStoreOptions } from './state-store'
import { assertHostStoreStorage } from './document-storage'
import { HostConfigStore, type HostConfigStoreOptions } from './config-store'
import { coercePluginConfigRecords } from './config-records'
import { installPluginSources, type PluginSource, type PluginSourceChange } from './sources'
import { openPluginSources, type PluginSourceSession } from './source-session'
import { collectPluginModuleExports } from './module'
import { prepareHostRpcCatalog } from './rpc-catalog'

type ServiceCapabilities<TServices extends readonly HostService[]> =
	number extends TServices['length']
		? readonly ContextCapabilityInstallation[]
		: TServices extends readonly [
					infer Head extends HostService,
					...infer Tail extends readonly HostService[],
			  ]
			? readonly [...Head['capabilities'], ...ServiceCapabilities<Tail>]
			: readonly []

type ValidateHostServices<TServices extends readonly HostService[]> = ValidateContextInstallations<
	ServiceCapabilities<TServices>,
	Exclude<keyof Context, keyof ContextServices> | 'constructor' | '__proto__'
>

type HostBaseOptions<TServices extends readonly HostService[] = readonly HostService[]> = Readonly<{
	/** Positive service list, fixed before root creation. Omitted means no additional services. */
	services?: TServices & ValidateHostServices<TServices>
	/** Explicit definition catalog. A definition is activated only by state.autoStart or startNode. */
	plugins: readonly PluginConstructor[]
	/** Core root settings; omitted values use Core defaults. */
	config?: CoreHostConfig
	/** Graph policy seed and optional borrowed document storage. Omitted means empty in-memory state. */
	state?: HostStateStoreOptions
	/** Plugin config seeds and optional borrowed document storage. Omitted means in-memory config. */
	configRecords?: HostConfigStoreOptions
	/** Resolved deployment records installed before Plugin admission. */
	vaultBindings?: readonly HostVaultBindingRecord[]
}>

export type HostRuntimeOptions = Omit<HostBaseOptions, 'plugins'>
/** Complete configuration returned by an application factory for one fresh Host. */
export type HostApplication = Omit<HostBaseOptions, 'vaultBindings'> &
	Readonly<{
		name?: string
		/** Explicit config overlays and complete read-only Vault records. */
		envBindings?: readonly HostEnvironmentBinding[]
		fileBindings?: readonly HostFileBinding[]
		sources?: readonly PluginSource[]
		prepare?(input: {
			host: PluginHost
			startup: import('./application').HostStartupContext
		}): void | Promise<void>
	}>

export type HostOptions<TServices extends readonly HostService[] = readonly HostService[]> =
	HostBaseOptions<TServices> &
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

export interface PluginHost<TServices extends readonly HostService[] = readonly HostService[]> {
	readonly ctx: RootContext & RootContextProjection<ServiceCapabilities<TServices>>
	readonly config: HostPluginConfig
	/** A snapshot of availability, running intent and lifecycle outcomes from one committed graph. */
	status(): Promise<HostPluginStatusOverview>
	/** Persist startup intent and reconcile the same committed graph. */
	setAutoStart(address: PluginNodeAddress, autoStart: boolean): Promise<PluginApplyReport>
	setProviderDefault(
		token: PluginDefinitionAddress,
		provider: PluginNodeAddress | null,
	): Promise<PluginApplyReport>
	setDependencyOverride(
		consumer: PluginNodeAddress,
		requirement: PluginDefinitionAddress,
		provider: PluginNodeAddress | null,
	): Promise<PluginApplyReport>
	readonly forks: {
		ensure(
			base: PluginNodeAddress,
			forkId: string,
			options?: Parameters<typeof ensureFork>[3],
		): Promise<ForkEnsureResult>
		remove(base: PluginNodeAddress, forkId: string): Promise<ForkRemoveResult>
	}
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

/** Validate and prepare a fixed service composition. Plugin generations start only through start(). */
export async function createHost<const TServices extends readonly HostService[] = readonly []>(
	options: HostOptions<TServices>,
): Promise<PluginHost<TServices>> {
	assertHostStoreStorage(options.state ?? {})
	assertHostStoreStorage(options.configRecords ?? {})
	const initialState = resolveHostStateInitial(options.state?.initial)
	const initialConfig = coercePluginConfigRecords(options.configRecords?.initial ?? [])
	const fixed = [...options.plugins]
	catalog(1, fixed) // Admit explicit definitions before creating any root resources.
	await validateInputBindingCandidates(fixed, options)
	const services = planHostServices(options.services ?? [])
	const shape = createCoreContextHost({
		...options.config,
		createLifecycleHooks: (ctx) => createHostServiceLifecycle(ctx, services),
		capabilities: services.flatMap((service) => [...service.capabilities]),
		createConfigService: (ctx) =>
			new HostConfigStore(ctx, { ...options.configRecords, initial: initialConfig }),
	})
	const ctx = shape.createRoot(options.config?.name)
	try {
		const state = new HostStateStore(ctx, { ...options.state, initial: initialState })
		hostStateStores.set(ctx, state)
		ctx.effects.defer(
			() => {
				hostStateStores.delete(ctx)
			},
			{ phase: 'shutdown' },
		)
		await Promise.all([state.ready, requireConfigService(ctx).ready])
		installPluginHostCoordinator(ctx, { state })
		await prepareHostServices(ctx, services)
		if (options.vaultBindings?.length)
			await ctx.require(HostVaultBindings).install(options.vaultBindings)
		return createPreparedHost(options, fixed, ctx) as PluginHost<TServices>
	} catch (error) {
		const failures: unknown[] = [error]
		try {
			await closeOwnerInvocations(ctx)
			await ctx.effects.dispose()
		} catch (cleanupError) {
			failures.push(cleanupError)
		}
		if (failures.length > 1) {
			throw new AggregateError(failures, '[host] preparation and cleanup failed', { cause: error })
		}
		throw error
	}
}

function createPreparedHost(
	options: HostOptions,
	fixed: readonly PluginConstructor[],
	ctx: RootContext,
): PluginHost {
	const coordinator = requirePluginHostCoordinator(ctx)
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
		await validateInputBindingCandidates(combined(next), options)
		const nextCatalog = catalog(++revision, combined(next), ctx)
		const publishRpc = prepareHostRpcCatalog(ctx, nextCatalog)
		await coordinator.update({
			catalog: nextCatalog,
			reason: 'catalog-update',
			onGraphCommitted: publishRpc,
		})
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
			await validateInputBindingCandidates(combined(modules), options)
			const initialCatalog = catalog(++revision, combined(modules), ctx)
			const publishRpc = prepareHostRpcCatalog(ctx, initialCatalog)
			return coordinator.update({
				catalog: initialCatalog,
				mode: 'cold-boot',
				reason: 'startup',
				onGraphCommitted: publishRpc,
			})
		})())
	}
	const updateCatalog = async (
		plugins: readonly PluginConstructor[],
		onGraphCommitted?: () => void,
	): Promise<PluginApplyReport> => {
		assertOpen()
		await startHost()
		assertOpen()
		const next = [...plugins]
		const task = sourceTail.then(async () => {
			assertOpen()
			await validateInputBindingCandidates(combined(modules, next), options)
			const nextCatalog = catalog(++revision, combined(modules, next), ctx)
			const publishRpc = prepareHostRpcCatalog(ctx, nextCatalog)
			const report = await coordinator.update({
				catalog: nextCatalog,
				reason: 'catalog-update',
				onGraphCommitted: () => {
					publishRpc()
					fixedPlugins = next
					onGraphCommitted?.()
				},
			})
			return report
		})
		sourceTail = task.then(
			(): void => undefined,
			(): void => undefined,
		)
		return task
	}
	hostCatalogUpdaters.set(ctx, updateCatalog)

	return Object.freeze({
		ctx,
		start: startHost,
		async status() {
			await startHost()
			assertOpen()
			return readHostPluginStatusOverview(ctx)
		},
		async setAutoStart(address: PluginNodeAddress, autoStart: boolean) {
			await startHost()
			assertOpen()
			return coordinator.updateRuntimeState(
				hostStatePatch({ type: 'set-auto-start', node: address, autoStart }),
				'plugin-auto-start-set',
			)
		},
		async setProviderDefault(token: PluginDefinitionAddress, provider: PluginNodeAddress | null) {
			await startHost()
			assertOpen()
			return coordinator.updateRuntimeState(
				hostStatePatch({ type: 'set-provider-default', token, provider }),
				'plugin-provider-default-set',
			)
		},
		async setDependencyOverride(
			consumer: PluginNodeAddress,
			requirement: PluginDefinitionAddress,
			provider: PluginNodeAddress | null,
		) {
			await startHost()
			assertOpen()
			return coordinator.updateRuntimeState(
				hostStatePatch({ type: 'set-dependency-override', consumer, requirement, provider }),
				'plugin-dependency-override-set',
			)
		},
		forks: Object.freeze({
			async ensure(
				base: PluginNodeAddress,
				forkId: string,
				forkOptions?: Parameters<typeof ensureFork>[3],
			) {
				await startHost()
				assertOpen()
				return ensureFork(ctx, base, forkId, forkOptions)
			},
			async remove(base: PluginNodeAddress, forkId: string) {
				await startHost()
				assertOpen()
				return removeFork(ctx, base, forkId)
			},
		}),
		config: Object.freeze({
			async get(owner: PluginNodeAddress) {
				await startHost()
				assertOpen()
				return pluginConfigGet(ctx, owner)
			},
			async validate(owner: PluginNodeAddress, patch: Record<string, unknown>) {
				await startHost()
				assertOpen()
				return pluginConfigValidate(ctx, owner, patch)
			},
			async patch(owner: PluginNodeAddress, patch: Record<string, unknown>) {
				await startHost()
				assertOpen()
				return pluginConfigPatch(ctx, owner, patch)
			},
			async reset(owner: PluginNodeAddress, keys?: readonly string[]) {
				await startHost()
				assertOpen()
				return pluginConfigReset(ctx, owner, keys)
			},
		}),
		catalog: () => coordinator.catalogSnapshot(),
		updateCatalog: (plugins: readonly PluginConstructor[]) => updateCatalog(plugins),
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
				const rootDrain = closeOwnerInvocations(ctx)
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
				try {
					await rootDrain
				} catch (error) {
					failures.push(error)
				}
				let providerDefaults: readonly PluginDefinitionAddress[] = []
				try {
					// Pin the final applied policy after queued updates, then close admission immediately.
					const [defaults] = await Promise.all([
						coordinator.readCommitted(({ applied }) =>
							[...applied.providerDefaults.values()].map(({ token }) => token),
						),
						coordinator.dispose(),
					])
					providerDefaults = defaults
				} catch (error) {
					failures.push(error)
				}
				try {
					const registry = requirePluginService(ctx)
					const nodes = registry.readCommittedDependencyAdjacency().nodes
					if (nodes.length > 0) {
						const update = registry.beginUpdate({ reason: 'host-close' })
						for (const token of providerDefaults) update.setProviderDefault(token, null)
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

function catalog(
	revision: number,
	plugins: readonly PluginConstructor[],
	ctx?: RootContext,
): PluginCatalogSnapshot {
	return createPluginCatalogSnapshot(
		revision,
		plugins.map((plugin) => ({
			candidate: consumePluginDefinitionCandidate(plugin),
			provenance: ctx ? readHostCatalogProvenance(ctx, plugin) : undefined,
		})),
	)
}

const hostStateStores = new WeakMap<RootContext, HostStateStore>()
/** The same prepared policy store used by the root's sole coordinator. */
export function requireHostStateStore(ctx: Context): HostStateStore {
	const store = hostStateStores.get(ctx.root)
	if (!store) throw new Error('[host] root has no Host state store')
	return store
}

const hostCatalogUpdaters = new WeakMap<
	RootContext,
	(
		plugins: readonly PluginConstructor[],
		onGraphCommitted?: () => void,
	) => Promise<PluginApplyReport>
>()
/** Development adapters activate prepared resources at graph acceptance, before new Plugin startup. */
export function updateHostCatalog(
	host: PluginHost,
	plugins: readonly PluginConstructor[],
	options: Readonly<{ onGraphCommitted: () => void }>,
): Promise<PluginApplyReport> {
	const update = hostCatalogUpdaters.get(host.ctx)
	if (!update) throw new Error('[host] catalog updater is unavailable')
	return update(plugins, options.onGraphCommitted)
}
