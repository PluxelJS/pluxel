import { validateInputBindingCandidates } from './input-binding-contract'
import { readHostCatalogProvenance } from './catalog-provenance'
import { readHostPluginStatusOverview, type HostPluginStatusOverview } from './status'
import { ensureFork, removeFork, type ForkEnsureResult, type ForkRemoveResult } from './forks'
import { hostStatePatch } from './state'
import {
	pluginConfigGet,
	pluginConfigValidate,
	pluginConfigPatch,
	pluginConfigReset,
	readHostConfigState,
	reloadSavedConfig,
	type HostPluginConfig,
} from './config'
import {
	formatPluginNodeReference,
	type Context,
	type PluginConstructor,
	type PluginNodeAddress,
	type PluginForkNodeAddress,
	type PluginDefinitionAddress,
	type RootContext,
} from '@pluxel/core'
import { PluginLoweringError } from '@pluxel/core/toolchain'
import {
	closeOwnerInvocations,
	createCoreContextHostWithFacilities,
	createCorePluginExecutionBinding,
	consumePluginDefinitionCandidate,
	prepareCoreContext,
	requireConfigService,
	requirePluginService,
	requireVaultHost,
	snapshotVaultBindings,
} from '@pluxel/core/internal'
import { planHostServices, prepareHostServices, createHostServiceLifecycle } from './services'
import {
	createPluginCatalogSnapshot,
	pluginCatalogEntry,
	type PluginCatalogSnapshot,
} from './catalog'
import type { PluginApplyReport, HostOperationOptions } from './coordinator'
import { installPluginHostCoordinator, requirePluginHostCoordinator } from './install'
import { HostStateStore } from './state-store'
import { resolveHostStoreStorage } from './document-storage'
import { HostConfigStore } from './config-store'
import { assertDataObject } from './config-records'
import { createHostPolicy, type HostPolicy } from './policy-management'
import type { PluginSource } from './sources'
import {
	HOST_DECLARATION_FIELDS,
	snapshotHostDeclarations,
	type HostDeclarations,
	type HostOptions,
	type ResolvedHostOptions,
	type SnapshotCoreFacilities,
} from './node-declarations'

export type { HostOptions } from './node-declarations'

/** Complete configuration returned by an application factory for one fresh Host. */
export type HostApplication<Startup = import('./node-application').HostStartupContext> =
	HostDeclarations &
		Readonly<{
			/** Discover implementations into the same catalog as the directly selected constructors. */
			sources?: readonly PluginSource[]
			prepare?: (input: { host: PluginHost; startup: Startup }) => void | Promise<void>
			/** Production startup decision after graph settlement. Omitted requires every intended node to be running. */
			acceptStartup?: (
				input: import('./application-start').HostApplicationStartup<Startup>,
			) => boolean | Promise<boolean>
			/** Publish the production entry point after startup is accepted. Register resources with host.ctx.effects. */
			launch?: (input: { host: PluginHost; startup: Startup }) => void | Promise<void>
		}>

export interface PluginHost extends AsyncDisposable {
	readonly ctx: RootContext
	readonly config: HostPluginConfig
	readonly policy: HostPolicy
	/** A snapshot of availability, running intent and lifecycle outcomes from one committed graph. */
	status(): Promise<HostPluginStatusOverview>
	/** Persist startup intent and reconcile the same committed graph. */
	setAutoStart(
		address: PluginNodeAddress,
		autoStart: boolean,
		options?: HostOperationOptions,
	): Promise<PluginApplyReport>
	setProviderDefault(
		token: PluginDefinitionAddress,
		provider: PluginNodeAddress | null,
		options?: HostOperationOptions,
	): Promise<PluginApplyReport>
	setDependencyOverride(
		consumer: PluginNodeAddress,
		requirement: PluginDefinitionAddress,
		provider: PluginNodeAddress | null,
		options?: HostOperationOptions,
	): Promise<PluginApplyReport>
	readonly forks: {
		ensure(
			fork: PluginForkNodeAddress,
			options?: Parameters<typeof ensureFork>[2],
		): Promise<ForkEnsureResult>
		remove(fork: PluginForkNodeAddress, options?: HostOperationOptions): Promise<ForkRemoveResult>
	}
	/** Idempotently publishes the initial catalog and reconciles startup policy. */
	start(): Promise<PluginApplyReport>
	catalog(): PluginCatalogSnapshot
	/** Replaces the complete definition catalog, preserving running intent for retained addresses. */
	updateCatalog(
		plugins: readonly PluginConstructor[],
		options?: Readonly<{
			/** Publish prepared references synchronously before startup. The graph stays committed if publication throws. */
			onGraphCommitted?: () => undefined
		}>,
	): Promise<PluginApplyReport>
	startNode(address: PluginNodeAddress): Promise<PluginApplyReport>
	stopNode(address: PluginNodeAddress): Promise<PluginApplyReport>
	restartNode(address: PluginNodeAddress): Promise<PluginApplyReport>
	/** Stops admission, drains accepted graph operations, stops generations, and disposes the root. */
	close(): Promise<void>
}

/** Validate a fixed service composition and prepare it with the entry point's Core facilities. */
export async function createHostFromOptions(
	options: HostOptions,
	snapshotFacilities: SnapshotCoreFacilities,
): Promise<PluginHost> {
	assertDataObject(options, 'createHost options', [...HOST_DECLARATION_FIELDS, 'vaultBindings'])
	const declaration = snapshotHostDeclarations(options)
	if (declaration.bindings.envBindings.length > 0 || declaration.bindings.fileBindings.length > 0)
		throw new TypeError(
			'[host] envBindings and fileBindings require an application startup context',
		)
	return createResolvedHost({
		...declaration.options,
		coreConfig: snapshotFacilities(options.coreConfig),
		...(options.vaultBindings === undefined
			? {}
			: { vaultBindings: snapshotVaultBindings(options.vaultBindings) }),
	})
}

/** @internal Prepare the already captured declaration and its selected catalog. */
export async function createResolvedHost(
	options: ResolvedHostOptions,
	applicationEntry?: string,
): Promise<PluginHost> {
	const fixed = [...options.plugins]
	assertDeclaredForks(catalog(1, fixed), options.declaredNodes)
	const services = planHostServices(options.services ?? [])
	const executionBinding = createCorePluginExecutionBinding(options.nodeStartTimeoutMs)
	let configStorageOptions: ConstructorParameters<typeof HostConfigStore>[2] | undefined
	const context = createCoreContextHostWithFacilities(
		{
			name: options.name,
			executionBinding,
			services: services.flatMap((service) => service.provides),
			createLifecycleHooks: (root) => createHostServiceLifecycle(root, services),
			createConfigService(root) {
				if (!configStorageOptions)
					throw new Error('[host] document storage factories must not read Host config')
				return new HostConfigStore(root, options.config, configStorageOptions)
			},
		},
		options.coreConfig,
	)
	await validateInputBindingCandidates(fixed, options)
	const ctx = context.createRoot()
	try {
		const configStorage = resolveHostStoreStorage(options.config.document, ctx, 'config')
		const stateStorage = resolveHostStoreStorage(options.policy.document, ctx, 'state')
		configStorageOptions = configStorage
		const state = new HostStateStore(ctx, options.policy, stateStorage, options.declaredNodes)
		hostStateStores.set(ctx, state)
		ctx.effects.defer(
			() => {
				hostStateStores.delete(ctx)
			},
			{ phase: 'shutdown' },
		)
		await Promise.all([state.ready, requireConfigService(ctx).ready])
		executionBinding.bind(state.executionSnapshot())
		await prepareCoreContext(ctx)
		installPluginHostCoordinator(ctx, { state })
		if (options.vaultBindings?.length) requireVaultHost(ctx).installBindings(options.vaultBindings)
		await prepareHostServices(ctx, services, fixed, applicationEntry)
		const store = requireConfigService(ctx) as HostConfigStore
		await store.observe(() =>
			reloadSavedConfig(ctx, () => {
				const current = requirePluginHostCoordinator(ctx).catalogSnapshot()
				return current.revision === 0 ? catalog(0, fixed, ctx) : current
			}),
		)
		return createPreparedHost(options, fixed, ctx) as PluginHost
	} catch (error) {
		const failures: unknown[] = [error]
		try {
			await closeOwnerInvocations(ctx)
		} catch (cleanupError) {
			failures.push(cleanupError)
		}
		try {
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
	options: ResolvedHostOptions,
	fixed: readonly PluginConstructor[],
	ctx: RootContext,
): PluginHost {
	const coordinator = requirePluginHostCoordinator(ctx)
	const policy = createHostPolicy(ctx, requireHostStateStore(ctx))
	let start: Promise<PluginApplyReport> | undefined
	let closing: Promise<void> | undefined
	let revision = 0
	let fixedPlugins: readonly PluginConstructor[] = fixed
	let catalogTail = Promise.resolve()
	const assertOpen = (): void => {
		if (closing) throw new Error('[host] host is closed')
	}
	const startHost = (): Promise<PluginApplyReport> => {
		assertOpen()
		return (start ??= (async () => {
			assertOpen()
			// Initial binding candidates were validated before prepare. Catalog replacement awaits start.
			return coordinator.reconcileStartup(catalog(++revision, fixedPlugins, ctx))
		})())
	}
	const updateCatalog: PluginHost['updateCatalog'] = async (plugins, { onGraphCommitted } = {}) => {
		assertOpen()
		const next = [...plugins]
		await startHost()
		assertOpen()
		const committed = () => {
			fixedPlugins = next
			onGraphCommitted?.()
		}
		const operation = async () => {
			assertOpen()
			await validateInputBindingCandidates(next, options)
			const nextCatalog = catalog(++revision, next, ctx)
			assertDeclaredForks(nextCatalog, options.declaredNodes)
			const report = await coordinator.update({
				catalog: nextCatalog,
				reason: 'catalog-update',
				onGraphCommitted: committed,
			})
			return report
		}
		const task = catalogTail.then(operation)
		catalogTail = task.then(
			(): void => undefined,
			(): void => undefined,
		)
		return task
	}

	const close = (): Promise<void> => {
		return (closing ??= (async () => {
			const rootDrain = closeOwnerInvocations(ctx)
			const failures: unknown[] = []
			try {
				;(requireConfigService(ctx) as HostConfigStore).stopObserving()
			} catch (error) {
				failures.push(error)
			}
			try {
				await start
			} catch {
				/* Startup is reported to its original caller. */
			}
			try {
				await catalogTail
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
	}

	return Object.freeze({
		ctx,
		start: startHost,
		async status() {
			await startHost()
			assertOpen()
			return readHostPluginStatusOverview(ctx)
		},
		async setAutoStart(
			address: PluginNodeAddress,
			autoStart: boolean,
			mutation?: HostOperationOptions,
		) {
			await startHost()
			assertOpen()
			return coordinator.updateRuntimeState(
				hostStatePatch({ type: 'set-auto-start', node: address, autoStart }),
				'plugin-auto-start-set',
				mutation,
			)
		},
		async setProviderDefault(
			token: PluginDefinitionAddress,
			provider: PluginNodeAddress | null,
			mutation?: HostOperationOptions,
		) {
			await startHost()
			assertOpen()
			return coordinator.updateRuntimeState(
				hostStatePatch({ type: 'set-provider-default', token, provider }),
				'plugin-provider-default-set',
				mutation,
			)
		},
		async setDependencyOverride(
			consumer: PluginNodeAddress,
			requirement: PluginDefinitionAddress,
			provider: PluginNodeAddress | null,
			mutation?: HostOperationOptions,
		) {
			await startHost()
			assertOpen()
			return coordinator.updateRuntimeState(
				hostStatePatch({ type: 'set-dependency-override', consumer, requirement, provider }),
				'plugin-dependency-override-set',
				mutation,
			)
		},
		forks: Object.freeze({
			async ensure(fork: PluginForkNodeAddress, forkOptions?: Parameters<typeof ensureFork>[2]) {
				await startHost()
				assertOpen()
				return ensureFork(ctx, fork, forkOptions)
			},
			async remove(fork: PluginForkNodeAddress, mutation?: HostOperationOptions) {
				await startHost()
				assertOpen()
				return removeFork(ctx, fork, mutation)
			},
		}),
		policy: Object.freeze({
			async get(mutation) {
				await startHost()
				assertOpen()
				return policy.get(mutation)
			},
			async validate(values, mutation) {
				await startHost()
				assertOpen()
				return policy.validate(values, mutation)
			},
			async patch(values, mutation) {
				await startHost()
				assertOpen()
				return policy.patch(values, mutation)
			},
			async reset(keys, mutation) {
				await startHost()
				assertOpen()
				return policy.reset(keys, mutation)
			},
		} satisfies HostPolicy),
		config: Object.freeze({
			status: () => readHostConfigState(ctx),
			async get(owner: PluginNodeAddress) {
				await startHost()
				assertOpen()
				return pluginConfigGet(ctx, owner)
			},
			async validate(
				owner: PluginNodeAddress,
				patch: Parameters<HostPluginConfig['validate']>[1],
				mutation?: HostOperationOptions,
			) {
				await startHost()
				assertOpen()
				return pluginConfigValidate(ctx, owner, patch, mutation)
			},
			async patch(
				owner: PluginNodeAddress,
				patch: Parameters<HostPluginConfig['patch']>[1],
				mutation?: HostOperationOptions,
			) {
				await startHost()
				assertOpen()
				return pluginConfigPatch(ctx, owner, patch, mutation)
			},
			async reset(
				owner: PluginNodeAddress,
				keys?: Parameters<HostPluginConfig['reset']>[1],
				mutation?: HostOperationOptions,
			) {
				await startHost()
				assertOpen()
				return pluginConfigReset(ctx, owner, keys, mutation)
			},
		}),
		catalog: () => coordinator.catalogSnapshot(),
		updateCatalog,
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
		close,
		[Symbol.asyncDispose]: close,
	})
}

function assertDeclaredForks(
	snapshot: PluginCatalogSnapshot,
	nodes: readonly PluginNodeAddress[],
): void {
	for (const node of nodes) {
		if (node.variant !== 'fork') continue
		const entry = pluginCatalogEntry(snapshot, node.definition)
		if (entry && !entry.candidate.declaration.forkable)
			throw new TypeError(`[host] ${formatPluginNodeReference(node)} requires a forkable Plugin`)
	}
}

function catalog(
	revision: number,
	plugins: readonly PluginConstructor[],
	ctx?: RootContext,
): PluginCatalogSnapshot {
	return createPluginCatalogSnapshot(
		revision,
		plugins.map((plugin, index) => {
			if (typeof plugin !== 'function')
				throw new PluginLoweringError(
					'plugin_declaration_invalid',
					`[host] plugins[${index}] must be a Plugin constructor; supply implementations through plugins or application sources, and use nodeAddress() in policy/config targets`,
				)
			return {
				candidate: consumePluginDefinitionCandidate(plugin),
				provenance: ctx ? readHostCatalogProvenance(ctx, plugin) : undefined,
			}
		}),
	)
}

const hostStateStores = new WeakMap<RootContext, HostStateStore>()
/** The same prepared policy store used by the root's sole coordinator. */
export function requireHostStateStore(ctx: Context): HostStateStore {
	const store = hostStateStores.get(ctx.root)
	if (!store) throw new Error('[host] root has no Host state store')
	return store
}
