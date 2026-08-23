import {
	formatPluginNodeReference,
	pluginNodeAddressEqual,
	type Context,
	type CommitSummary,
	type PluginNodeAddress,
} from '@pluxel/core'
import { requireConfigService, requirePluginService } from '@pluxel/core/internal'
import type { ProductDescriptor } from '@pluxel/runtime/product'
import {
	createPluginRouteCatalogSnapshot,
	installRuntimePluginGraphCoordinator,
	installRuntimeRouteCapabilities,
	requireRuntimeStateStore,
	runtimePluginStatusOverview,
	type PluginApplyReport,
	type RuntimeRouteCapabilities,
} from '@pluxel/runtime/internal'
import {
	createContextPluginLogPolicyStore,
	createRuntimeRootContext,
	createRuntimeLogging,
	isWorkbenchEnabled,
	prepareContextCapabilities,
	type RuntimeHostConfig,
	type RuntimeLogging,
	type RuntimeLoggingInput,
} from '@pluxel/runtime/internal/static-host'
import type { WorkbenchBackendFactory } from '@pluxel/runtime/internal/static'
import {
	buildCatalog,
	collectUnknownConfigEntries,
	diffCatalog,
	readConfigSnapshot,
	type StaticRuntimeCatalog,
} from './catalog'
import type {
	StaticRuntimeCatalogSnapshot,
	StaticRuntimeDefinition,
	StaticRuntimeHmrController,
	StaticRuntimeHmrReport,
	StaticRuntimeHost,
	StaticRuntimeHostOptions,
	StaticRuntimeReportEntry,
	StaticRuntimeStartupReport,
} from '../types'

export class StaticRuntimeHostImpl implements StaticRuntimeHost {
	public readonly ctx: Context
	private readonly startupCatalog: StaticRuntimeCatalog
	private runtimeName: string
	private started = false
	private disposed = false
	private report: StaticRuntimeStartupReport | undefined
	private readonly coordinator

	public readonly hmr: StaticRuntimeHmrController = {
		reload: (definition) => this.reload(definition),
	}

	constructor(
		definition: StaticRuntimeDefinition,
		options: StaticRuntimeHostOptions,
		private readonly logging: RuntimeLogging,
		internal: StaticRuntimeHostInternalOptions,
	) {
		this.startupCatalog = buildCatalog(definition, 1)
		this.runtimeName = definition.name
		this.ctx = createRuntimeRootContext(
			createStaticRuntimeHostConfig(definition, options, logging, internal),
			{
				logging,
				product: internal.product ?? null,
				...(internal.createWorkbenchBackend
					? { workbench: { createBackend: internal.createWorkbenchBackend } }
					: {}),
			},
		)
		this.coordinator = installRuntimePluginGraphCoordinator(this.ctx)
		this.ctx.effects.defer(() => logging.dispose(), {
			tag: 'RuntimeLogging',
			phase: 'shutdown',
		})
		const uninstallRoute = installRuntimeRouteCapabilities(this.ctx, this.createRuntimeRoute())
		this.ctx.effects.defer(uninstallRoute, {
			tag: 'RuntimeRouteCapabilities',
			phase: 'shutdown',
		})
	}

	get definition(): StaticRuntimeDefinition {
		const catalog = this.catalogSnapshot()
		return Object.freeze({
			name: this.runtimeName,
			plugins: Object.freeze(catalog.entries.map((entry) => entry.candidate.implementation)),
		})
	}

	private createRuntimeRoute(): RuntimeRouteCapabilities {
		return {
			source: {
				resolveSource: () => ({
					__typename: 'PluginSourceInfo',
					kind: 'unknown',
					moduleId: null,
					packageName: null,
					version: null,
					tag: null,
				}),
			},
		}
	}

	async prepare(): Promise<void> {
		await Promise.all([
			requireConfigService(this.ctx).ready,
			requireRuntimeStateStore(this.ctx).ready,
		])
		await this.logging.initializePolicy(createContextPluginLogPolicyStore(this.ctx))
		await prepareContextCapabilities(this.ctx)
	}

	describeCatalog(): StaticRuntimeCatalogSnapshot {
		const catalog = this.catalogSnapshot()
		return {
			runtime: this.runtimeName,
			plugins: catalog.entries.map((entry) => ({
				address: { definition: entry.address, variant: 'default' },
				definition: entry.address,
				displayName: entry.candidate.declaration.displayName,
				rootExportName: entry.address.exportName,
				provenance: entry.address.entry,
			})),
		}
	}

	lastReport(): StaticRuntimeStartupReport | undefined {
		return this.report
	}

	async start(): Promise<StaticRuntimeStartupReport> {
		if (this.disposed) throw new Error('[runtime-static] cannot start a disposed host')
		if (this.started) return this.report ?? this.currentReport()
		const applied = await this.coordinator.reconcileStartup(this.startupCatalog)
		this.started = true
		this.report = this.currentReport(applied)
		return this.report
	}

	async stop(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		try {
			const empty = createPluginRouteCatalogSnapshot(
				this.coordinator.catalogSnapshot().revision + 1,
				[],
			)
			await this.coordinator.update({
				catalog: empty,
				reason: 'shutdown',
				mode: 'live',
			})
		} finally {
			try {
				await this.ctx.effects.dispose()
			} finally {
				await this.logging.dispose()
			}
		}
	}

	private async reload(definition: StaticRuntimeDefinition): Promise<StaticRuntimeHmrReport> {
		if (this.disposed) throw new Error('[runtime-static] cannot reload a disposed host')
		const previous = this.coordinator.catalogSnapshot()
		const next = buildCatalog(definition, previous.revision + 1)
		const diff = diffCatalog(previous, next)
		const applied = await this.coordinator.update({
			catalog: next,
			reason: 'static-hmr',
			mode: 'live',
		})
		this.runtimeName = definition.name
		this.started = true
		const base = this.currentReport(applied, diff.removed)
		const report: StaticRuntimeHmrReport = {
			...base,
			added: diff.added,
			removed: diff.removed,
			replaced: diff.replaced,
		}
		this.report = report
		return report
	}

	private currentReport(
		applied?: PluginApplyReport<CommitSummary>,
		removed: readonly PluginNodeAddress[] = [],
	): StaticRuntimeStartupReport {
		const issues = applied?.reconciliation ?? []
		const lifecycleIssues =
			applied?.core.status === 'committed' ? applied.core.summary.lifecycleReport.issues : []
		const registry = requirePluginService(this.ctx)
		const removedKeys = new Set(removed.map((address) => formatPluginNodeReference(address)))
		const reportedRemoved = new Set<string>()
		const entries: StaticRuntimeReportEntry[] = runtimePluginStatusOverview(this.ctx).statuses.map(
			(status) => {
				const reference = formatPluginNodeReference(status.address)
				if (removedKeys.has(reference)) {
					reportedRemoved.add(reference)
					return {
						address: status.address,
						displayName: status.displayName,
						rootExportName: status.rootExportName,
						status: 'catalog-drift',
						message: 'Plugin was removed from the static catalog',
					}
				}
				const issue = issues.find(
					(candidate) =>
						'consumer' in candidate && pluginNodeAddressEqual(candidate.consumer, status.address),
				)
				const lifecycleIssue = lifecycleIssues.find((candidate) =>
					pluginNodeAddressEqual(registry.nodeAddressOf(candidate.plugin), status.address),
				)
				const entry: StaticRuntimeReportEntry = {
					address: status.address,
					displayName: status.displayName,
					rootExportName: status.rootExportName,
					status: !status.isEnabled
						? 'disabled'
						: status.availability === 'unavailable'
							? 'unavailable'
							: status.isRunning
								? 'started'
								: issue?.kind === 'missing_required_provider'
									? 'dependency-missing'
									: lifecycleIssue?.kind === 'config-failed'
										? 'config-invalid'
										: lifecycleIssue?.kind === 'dependency-blocked'
											? 'dependency-failed'
											: 'start-failed',
				}
				if (issue) return Object.assign(entry, { message: issue.message })
				if (lifecycleIssue) {
					return Object.assign(entry, {
						message: lifecycleIssue.error?.message ?? lifecycleIssue.message,
					})
				}
				return entry
			},
		)
		const unknown = collectUnknownConfigEntries(
			readConfigSnapshot(requireConfigService(this.ctx)),
			this.coordinator.catalogSnapshot(),
			requireRuntimeStateStore(this.ctx).snapshot().enabled,
		)
		for (const address of unknown) {
			if (removed.some((candidate) => pluginNodeAddressEqual(candidate, address))) continue
			entries.push({
				address,
				displayName: address.definition.exportName,
				rootExportName: address.definition.exportName,
				status: 'unknown-config-entry',
			})
		}
		for (const address of removed) {
			if (reportedRemoved.has(formatPluginNodeReference(address))) continue
			entries.push({
				address,
				displayName: address.definition.exportName,
				rootExportName: address.definition.exportName,
				status: 'catalog-drift',
				message: 'Plugin was removed from the static catalog',
			})
		}
		return {
			runtime: this.runtimeName,
			entries,
			...(applied?.core.status === 'committed' ? { commit: applied.core.summary } : {}),
		}
	}

	/** @internal */
	catalogSnapshotForVite(): readonly Readonly<{
		address: PluginNodeAddress
		implementation: unknown
	}>[] {
		return this.catalogSnapshot().entries.map((entry) => ({
			address: { definition: entry.address, variant: 'default' },
			implementation: entry.candidate.implementation,
		}))
	}

	private catalogSnapshot(): StaticRuntimeCatalog {
		const committed = this.coordinator.catalogSnapshot()
		return committed.revision === 0 && !this.started ? this.startupCatalog : committed
	}
}

/** @internal Vite-only implementation lookup; constructors never enter the public catalog view. */
export function readStaticRuntimeImplementations(
	host: StaticRuntimeHost,
): readonly Readonly<{ address: PluginNodeAddress; implementation: unknown }>[] {
	if (!(host instanceof StaticRuntimeHostImpl)) {
		throw new TypeError('[runtime-static] host was not created by the static runtime adapter')
	}
	return host.catalogSnapshotForVite()
}

export async function createStaticRuntimeHost(
	definition: StaticRuntimeDefinition,
	options: StaticRuntimeHostOptions = {},
	internal: {
		deployment?: StaticRuntimeHostDeployment
		createWorkbenchBackend?: WorkbenchBackendFactory
		product?: ProductDescriptor | null
		http?: RuntimeHostConfig['http']
	} = {},
): Promise<StaticRuntimeHost> {
	const logging = createRuntimeLogging(resolveStaticRuntimeLoggingInput(definition, options))
	await logging.install()
	let host: StaticRuntimeHostImpl | undefined
	try {
		host = new StaticRuntimeHostImpl(definition, options, logging, internal)
		await host.prepare()
		return host
	} catch (error) {
		if (host) await host.stop().catch((): undefined => undefined)
		else await logging.dispose().catch((): undefined => undefined)
		throw error
	}
}

export type StaticRuntimeHostDeployment = {
	root: string
	publicDir?: string
	workbenchDir?: string
	nodeModulesDir: string
	workbenchIncluded: boolean
}

type StaticRuntimeHostInternalOptions = Readonly<{
	deployment?: StaticRuntimeHostDeployment
	createWorkbenchBackend?: WorkbenchBackendFactory
	product?: ProductDescriptor | null
	http?: RuntimeHostConfig['http']
}>

function resolveStaticRuntimeLoggingInput(
	definition: StaticRuntimeDefinition,
	options: StaticRuntimeHostOptions,
): RuntimeLoggingInput {
	if (options.logging !== undefined && options.logging !== false) return options.logging
	const root = {
		profile: options.profile ?? definition.name,
		debugTopics: resolveStaticDebugTopics(options.debug),
	}
	if (options.logging === false) {
		return {
			root,
			sinks: {},
			routes: { runtime: [], plugins: [], debug: [], meta: [] },
		}
	}
	const withStore = isWorkbenchEnabled(options.workbench)
	const sinks: RuntimeLoggingInput['sinks'] = {
		console: { kind: 'console', format: 'pretty', caller: false, timezone: 'local' },
	}
	if (withStore) sinks.store = { kind: 'store', streamId: 'default', caller: true }
	const storeRoute = withStore ? [{ sink: 'store', minLevel: 'trace' as const }] : []
	return {
		root,
		sinks,
		routes: {
			runtime: [{ sink: 'console', minLevel: 'info' }, ...storeRoute],
			plugins: [{ sink: 'console', minLevel: 'trace' }, ...storeRoute],
			debug: [{ sink: 'console', minLevel: 'trace' }, ...storeRoute],
			meta: [{ sink: 'console', minLevel: 'warning' }],
		},
	}
}

function resolveStaticDebugTopics(value: unknown): readonly string[] {
	return Array.isArray(value)
		? value.filter((topic): topic is string => typeof topic === 'string')
		: []
}

function createStaticRuntimeHostConfig(
	definition: StaticRuntimeDefinition,
	options: StaticRuntimeHostOptions,
	logging: RuntimeLogging,
	internal: StaticRuntimeHostInternalOptions,
): RuntimeHostConfig {
	const { logging: _logging, profile: _profile, ...runtime } = options
	const configService = options.configService
	const inheritedRuntimeState =
		!options.runtimeState && configService?.mode ? { mode: configService.mode } : undefined
	return {
		...runtime,
		name: definition.name,
		http: {
			...internal.http,
			...(internal.deployment?.publicDir ? { uiPublicDir: internal.deployment.publicDir } : {}),
		},
		configService,
		runtimeState: options.runtimeState ?? inheritedRuntimeState,
		logger: logging.contextBinding,
		...(internal.deployment
			? {
					nodeModuleArtifactRoot: internal.deployment.nodeModulesDir,
					...(internal.deployment.workbenchDir
						? { workbenchArtifactRoot: internal.deployment.workbenchDir }
						: {}),
				}
			: {}),
	}
}
