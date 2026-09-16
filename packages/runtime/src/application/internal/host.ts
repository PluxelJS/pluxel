import {
	formatPluginNodeReference,
	pluginNodeAddressEqual,
	type Context,
	type CommitSummary,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { requireConfigService, requirePluginService } from '@pluxel/core/internal'
import type { ProductDescriptor } from '../../product.ts'
import {
	createPluginRouteCatalogSnapshot,
	installRuntimePluginGraphCoordinator,
	installRuntimeRouteCapabilities,
	readRuntimePluginStatusOverview,
	requireRuntimeHttpService,
	requireRuntimeStateStore,
	type ElysiaCarrierRequestAddress,
	type PluginApplyReport,
	type PluginExecutionSnapshot,
} from '../../internal.ts'
import {
	createContextPluginLogPolicyStore,
	createRuntimeRootContext,
	createRuntimeLogging,
	isWorkbenchEnabled,
	prepareRuntimeRootContext,
	type RuntimeHostConfig,
	type RuntimeLogging,
	type RuntimeLoggingInput,
} from '../../internal-static-host.ts'
import type { WorkbenchBackendFactory } from '../../internal-static.ts'
import {
	buildCatalog,
	collectUnknownConfigEntries,
	diffCatalog,
	readConfigSnapshot,
	type RuntimeCatalog,
	type RuntimeCatalogDiff,
	type RuntimeExecutionResolver,
} from './catalog.ts'
import { RuntimeRecentUpdateTracker } from './recent-update.ts'
import type {
	RuntimeCatalogSnapshot,
	RuntimeDefinition,
	RuntimeHmrController,
	RuntimeHost,
	RuntimeHostOptions,
	RuntimeInternalHmrReport,
	RuntimeInternalStartupReport,
	RuntimeReportEntry,
} from '../types.ts'

type RuntimeViteReloadOutcome =
	| Readonly<{ status: 'applied'; report: RuntimeInternalHmrReport }>
	| Readonly<{ status: 'failed'; error: unknown; catalogCommitted: boolean }>

type RuntimeReloadSettlement = {
	catalogCommitted: boolean
}

export class RuntimeHostImpl implements RuntimeHost {
	public readonly ctx: Context
	private readonly startupCatalog: RuntimeCatalog
	private runtimeName: string
	private started = false
	private disposed = false
	private stopRequested = false
	private operationTail: Promise<void> = Promise.resolve()
	private stopPromise: Promise<void> | undefined
	private report: RuntimeInternalStartupReport | undefined
	private readonly coordinator
	private readonly resolveExecution: RuntimeExecutionResolver
	private readonly recentUpdates: RuntimeRecentUpdateTracker

	public readonly hmr: RuntimeHmrController & {
		reload(definition: RuntimeDefinition): Promise<RuntimeInternalHmrReport>
	} = {
		reload: (definition) => this.reload(definition, performance.now()),
	}

	readonly fetch = (request: Request, env?: unknown, fetchContext?: unknown) =>
		requireRuntimeHttpService(this.ctx).fetch(request, env, fetchContext)

	constructor(
		definition: RuntimeDefinition,
		options: RuntimeHostOptions,
		private readonly logging: RuntimeLogging,
		internal: RuntimeHostInternalOptions,
	) {
		this.resolveExecution =
			internal.resolveExecution ??
			(() => (internal.deployment ? STATIC_DEPLOYMENT_EXECUTION : STATIC_MANUAL_CATALOG_EXECUTION))
		this.recentUpdates = internal.recentUpdates ?? new RuntimeRecentUpdateTracker()
		this.startupCatalog = buildCatalog(definition, 1, this.resolveExecution)
		this.runtimeName = definition.name
		this.ctx = createRuntimeRootContext(
			createRuntimeHostConfig(definition, options, logging, internal),
			{
				logging,
				product: internal.product ?? null,
				...(internal.requestAddress ? { requestAddress: internal.requestAddress } : {}),
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
		const uninstallRoute = installRuntimeRouteCapabilities(this.ctx, {
			recentUpdate: this.recentUpdates,
		})
		this.ctx.effects.defer(uninstallRoute, {
			tag: 'RuntimeRouteCapabilities',
			phase: 'shutdown',
		})
	}

	get definition(): RuntimeDefinition {
		const catalog = this.catalogSnapshot()
		return Object.freeze({
			name: this.runtimeName,
			plugins: Object.freeze(catalog.entries.map((entry) => entry.candidate.implementation)),
		})
	}

	async prepare(): Promise<void> {
		await Promise.all([
			requireConfigService(this.ctx).ready,
			requireRuntimeStateStore(this.ctx).ready,
		])
		await this.logging.initializePolicy(createContextPluginLogPolicyStore(this.ctx))
		await prepareRuntimeRootContext(this.ctx.root)
	}

	describeCatalog(): RuntimeCatalogSnapshot {
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

	lastReport(): RuntimeInternalStartupReport | undefined {
		return this.report
	}

	start(): Promise<RuntimeInternalStartupReport> {
		if (this.stopRequested || this.disposed) {
			return Promise.reject(new Error('[runtime] cannot start a disposed host'))
		}
		return this.enqueueOperation(() => this.startExclusive())
	}

	private async startExclusive(): Promise<RuntimeInternalStartupReport> {
		if (this.started) return this.report ?? (await this.currentReport())
		const applied = await this.coordinator.reconcileStartup(this.startupCatalog)
		this.started = true
		this.report = await this.currentReport(applied)
		return this.report
	}

	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise
		if (this.disposed) return Promise.resolve()
		this.stopRequested = true
		const stopped = this.enqueueOperation(() => this.stopExclusive())
		this.stopPromise = stopped
		return stopped
	}

	private async stopExclusive(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		const errors: unknown[] = []
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
		} catch (error) {
			errors.push(error)
		}
		try {
			await this.ctx.effects.dispose()
		} catch (error) {
			errors.push(error)
		}
		try {
			await this.logging.dispose()
		} catch (error) {
			errors.push(error)
		}
		throwRuntimeErrors(errors, '[runtime] host shutdown failed')
	}

	private reload(
		definition: RuntimeDefinition,
		startedAt: number,
		settlement?: RuntimeReloadSettlement,
		onGraphCommitted?: () => void,
	): Promise<RuntimeInternalHmrReport> {
		if (this.stopRequested || this.disposed) {
			return Promise.reject(new Error('[runtime] cannot reload a disposed host'))
		}
		return this.enqueueOperation(() =>
			this.reloadExclusive(definition, startedAt, settlement, onGraphCommitted),
		)
	}

	/** @internal Preserves candidate preparation time and reports the exact catalog publication point. */
	async applyDefinitionUpdate(
		definition: RuntimeDefinition,
		startedAt: number,
		options: Readonly<{ onGraphCommitted?: () => void }> = {},
	): Promise<RuntimeViteReloadOutcome> {
		const settlement: RuntimeReloadSettlement = { catalogCommitted: false }
		try {
			return Object.freeze({
				status: 'applied',
				report: await this.reload(definition, startedAt, settlement, options.onGraphCommitted),
			})
		} catch (error) {
			return Object.freeze({
				status: 'failed',
				error,
				catalogCommitted: settlement.catalogCommitted,
			})
		}
	}

	private async reloadExclusive(
		definition: RuntimeDefinition,
		startedAt: number,
		settlement?: RuntimeReloadSettlement,
		onGraphCommitted?: () => void,
	): Promise<RuntimeInternalHmrReport> {
		const previous = this.coordinator.catalogSnapshot()
		let next: RuntimeCatalog
		try {
			next = buildCatalog(definition, previous.revision + 1, this.resolveExecution)
		} catch (error) {
			const proposedImplementations = new Set(definition.plugins)
			this.recentUpdates.recordDefinitions(
				previous.entries
					.filter((entry) => !proposedImplementations.has(entry.candidate.implementation))
					.map((entry) => entry.address),
				{
					outcome: 'retained-previous',
					phase: 'inject',
					durationMs: elapsedRuntimeUpdateMs(startedAt),
				},
			)
			throw error
		}
		const diff = diffCatalog(previous, next)
		let applied: PluginApplyReport<CommitSummary>
		try {
			applied = await this.coordinator.update({
				catalog: next,
				reason: 'static-hmr',
				onGraphCommitted,
				mode: 'live',
			})
		} catch (error) {
			const committed = this.coordinator.catalogSnapshot() === next
			if (settlement) settlement.catalogCommitted = committed
			if (committed) {
				// Core cannot structurally roll back after teardown starts. Its graph-commit callback
				// publishes this exact catalog before any later await, so a rejected update may still
				// have made the proposed definition generation authoritative.
				this.runtimeName = definition.name
				this.started = true
			}
			this.recentUpdates.recordDefinitions(
				definitionsFromCatalogDiff(diff),
				committed
					? {
							outcome: 'applied-with-issues',
							phase: 'commit',
							durationMs: elapsedRuntimeUpdateMs(startedAt),
						}
					: {
							outcome: 'retained-previous',
							phase: 'commit',
							durationMs: elapsedRuntimeUpdateMs(startedAt),
						},
			)
			throw error
		}
		if (settlement) settlement.catalogCommitted = this.coordinator.catalogSnapshot() === next
		this.runtimeName = definition.name
		this.started = true
		const affectedDefinitions = definitionsFromCatalogDiff(diff)
		let base: RuntimeInternalStartupReport
		try {
			base = await this.currentReport(applied, diff.removed)
		} catch (error) {
			// The catalog is already authoritative. A report projection failure is a post-PONR
			// diagnostic issue, not evidence that the previous Plugin generation was retained.
			this.recentUpdates.recordDefinitions(
				affectedDefinitions,
				{
					outcome: 'applied-with-issues',
					phase: 'commit',
					durationMs: elapsedRuntimeUpdateMs(startedAt),
				},
				{
					scope: 'definitions',
					...(applied.core.status === 'committed'
						? {
								lifecycle: {
									commit: applied.core.summary,
									addressOf: (slot) => requirePluginService(this.ctx).nodeAddressOf(slot),
								},
							}
						: {}),
				},
			)
			throw error
		}
		this.recordAppliedReload(affectedDefinitions, applied, startedAt)
		const report: RuntimeInternalHmrReport = {
			...base,
			added: diff.added,
			removed: diff.removed,
			replaced: diff.replaced,
		}
		this.report = report
		return report
	}

	private recordAppliedReload(
		definitions: Iterable<PluginDefinitionAddress>,
		applied: PluginApplyReport<CommitSummary>,
		startedAt: number,
	): void {
		this.recentUpdates.recordDefinitions(
			definitions,
			applied.core.status === 'committed' && !applied.core.summary.lifecycleReport.ok
				? {
						outcome: 'applied-with-issues',
						phase: 'lifecycle',
						durationMs: elapsedRuntimeUpdateMs(startedAt),
					}
				: {
						outcome: 'applied',
						phase: null,
						durationMs: elapsedRuntimeUpdateMs(startedAt),
					},
			{
				scope: 'definitions',
				...(applied.core.status === 'committed'
					? {
							lifecycle: {
								commit: applied.core.summary,
								addressOf: (slot) => requirePluginService(this.ctx).nodeAddressOf(slot),
							},
						}
					: {}),
			},
		)
	}

	private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationTail.then(operation)
		this.operationTail = result.then(
			(): void => undefined,
			(): void => undefined,
		)
		return result
	}

	private async currentReport(
		applied?: PluginApplyReport<CommitSummary>,
		removed: readonly PluginNodeAddress[] = [],
	): Promise<RuntimeInternalStartupReport> {
		const issues = applied?.reconciliation ?? []
		const lifecycleIssues =
			applied?.core.status === 'committed' ? applied.core.summary.lifecycleReport.issues : []
		const registry = requirePluginService(this.ctx)
		const removedKeys = new Set(removed.map((address) => formatPluginNodeReference(address)))
		const reportedRemoved = new Set<string>()
		const overview = await readRuntimePluginStatusOverview(this.ctx)
		const entries: RuntimeReportEntry[] = overview.statuses.map((status) => {
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
			const entry: RuntimeReportEntry = {
				address: status.address,
				displayName: status.displayName,
				rootExportName: status.rootExportName,
				status:
					status.desiredState === 'stopped'
						? 'stopped'
						: status.availability === 'unavailable'
							? 'unavailable'
							: status.lifecycleState === 'running'
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
		})
		const unknown = collectUnknownConfigEntries(
			readConfigSnapshot(requireConfigService(this.ctx)),
			this.coordinator.catalogSnapshot(),
			overview.statuses.map((status) => status.address),
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
		execution: PluginExecutionSnapshot
	}>[] {
		return this.catalogSnapshot().entries.map((entry) => ({
			address: { definition: entry.address, variant: 'default' },
			implementation: entry.candidate.implementation,
			execution: entry.provenance.execution ?? STATIC_MANUAL_CATALOG_EXECUTION,
		}))
	}

	private catalogSnapshot(): RuntimeCatalog {
		const committed = this.coordinator.catalogSnapshot()
		return committed.revision === 0 && !this.started ? this.startupCatalog : committed
	}
}

/** @internal Vite-only implementation lookup; constructors never enter the public catalog view. */
export function readRuntimeImplementations(
	host: RuntimeHost,
): readonly Readonly<{ address: PluginNodeAddress; implementation: unknown }>[] {
	if (!(host instanceof RuntimeHostImpl)) {
		throw new TypeError('[runtime] host was not created by the static runtime adapter')
	}
	return host.catalogSnapshotForVite()
}

export async function createRuntimeHost(
	definition: RuntimeDefinition,
	options: RuntimeHostOptions = {},
	internal: {
		deployment?: RuntimeHostDeployment
		createWorkbenchBackend?: WorkbenchBackendFactory
		product?: ProductDescriptor | null
		http?: RuntimeHostConfig['http']
		resolveExecution?: RuntimeExecutionResolver
		recentUpdates?: RuntimeRecentUpdateTracker
		/** @internal Capture bounded logs for the opt-in Vite development console. */
		devConsole?: boolean
		/** @internal Test-only physical peer seam. */
		requestAddress?: (request: Request) => ElysiaCarrierRequestAddress | null
	} = {},
): Promise<RuntimeHostImpl> {
	const logging = createRuntimeLogging(
		resolveRuntimeLoggingInput(definition, options, internal.devConsole === true),
	)
	await logging.install()
	let host: RuntimeHostImpl | undefined
	try {
		host = new RuntimeHostImpl(definition, options, logging, internal)
		await host.prepare()
		return host
	} catch (error) {
		try {
			if (host) await host.stop()
			else await logging.dispose()
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				'[runtime] host startup and cleanup both failed',
				{ cause: cleanupError },
			)
		}
		throw error
	}
}

function throwRuntimeErrors(errors: readonly unknown[], message: string): void {
	if (errors.length === 1) throw errors[0]
	if (errors.length > 1) throw new AggregateError(errors, message)
}

export type RuntimeHostDeployment = {
	root: string
	publicDir?: string
	workbenchDir?: string
	nodeModulesDir: string
	workbenchIncluded: boolean
}

type RuntimeHostInternalOptions = Readonly<{
	deployment?: RuntimeHostDeployment
	createWorkbenchBackend?: WorkbenchBackendFactory
	product?: ProductDescriptor | null
	http?: RuntimeHostConfig['http']
	resolveExecution?: RuntimeExecutionResolver
	recentUpdates?: RuntimeRecentUpdateTracker
	requestAddress?: (request: Request) => ElysiaCarrierRequestAddress | null
}>

const STATIC_DEPLOYMENT_EXECUTION = Object.freeze({
	kind: 'static-bundle' as const,
	artifact: Object.freeze({ kind: 'application-bundle' as const }),
	update: Object.freeze({ kind: 'deployment' as const }),
}) satisfies PluginExecutionSnapshot

const STATIC_MANUAL_CATALOG_EXECUTION = Object.freeze({
	kind: 'static-catalog' as const,
	artifact: Object.freeze({ kind: 'unreported' as const }),
	update: Object.freeze({ kind: 'manual' as const }),
}) satisfies PluginExecutionSnapshot

function definitionsFromCatalogDiff(diff: RuntimeCatalogDiff): PluginDefinitionAddress[] {
	return [...diff.added, ...diff.removed, ...diff.replaced].map((address) => address.definition)
}

function elapsedRuntimeUpdateMs(startedAt: number): number {
	return Math.max(0, performance.now() - startedAt)
}

function resolveRuntimeLoggingInput(
	definition: RuntimeDefinition,
	options: RuntimeHostOptions,
	devConsole: boolean,
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
	const withStore = devConsole || isWorkbenchEnabled(options.workbench)
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

function createRuntimeHostConfig(
	definition: RuntimeDefinition,
	options: RuntimeHostOptions,
	logging: RuntimeLogging,
	internal: RuntimeHostInternalOptions,
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
