import {
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type Context,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	pluginReconciliationIssueKey,
	requireRuntimePluginGraphCoordinator,
	type PluginActivationReason,
	type PluginReconciliationIssue,
	type PluginRouteCatalogSnapshot,
	type PluginSessionIntent,
	type RuntimePluginDesiredControl,
	type RuntimePluginSessionEntry,
} from '../internal/reconciliation'
import { runtimeStateReadIndex } from '../services/RuntimeStateHelpers'
import type { RuntimeStateSnapshot } from '../services/RuntimeStateStore'
import {
	clonePluginRecentUpdateSnapshot,
	UNREPORTED_PLUGIN_EXECUTION,
	type PluginExecutionSnapshot,
	type PluginRecentUpdateSnapshot,
	type RuntimeUpdateSnapshot,
} from '../plugin-execution'

export type RuntimePluginAvailability = 'available' | 'unavailable'
export type RuntimePluginReconciliationCode =
	| 'consumer_unavailable'
	| 'requirement_removed'
	| 'provider_unavailable'
	| 'provider_incompatible'
	| 'fork_not_allowed'
	| 'fork_default_forbidden'
	| 'provider_default_requires_abstract'
	| 'explicit_binding_invalid'
	| 'missing_required_provider'
	| 'definition_unavailable'
export type RuntimePluginStatusIssue = Readonly<{
	id: string
	code: RuntimePluginReconciliationCode
	message: string
}>

export type RuntimePluginCatalogEntry = Readonly<{
	address: PluginNodeAddress
	displayName: string
	rootExportName: string
}>

export type RuntimePluginStatusSnapshot = RuntimePluginCatalogEntry & {
	autoStart: boolean
	sessionIntent: PluginSessionIntent
	desiredState: 'running' | 'stopped'
	activationReason: PluginActivationReason | null
	lifecycleState: 'running' | 'stopped'
	availability: RuntimePluginAvailability
	issues: readonly RuntimePluginStatusIssue[]
	execution: PluginExecutionSnapshot
	recentUpdate: PluginRecentUpdateSnapshot | null
}

export type RuntimePluginStatusOverview = {
	statuses: RuntimePluginStatusSnapshot[]
	summary: { total: number; running: number; stopped: number; autoStart: number }
}

export interface PluginRecentUpdateRead {
	latestUpdate?(): RuntimeUpdateSnapshot | null
	subscribeUpdates?(observer: (snapshot: RuntimeUpdateSnapshot | null) => void): () => void
	resolveRecentUpdate(address: PluginNodeAddress): PluginRecentUpdateSnapshot | null
}

/** @internal Fixed inputs shared by status and dependency-graph projection. */
export type RuntimePluginStatusProjectionView = Readonly<{
	catalog: PluginRouteCatalogSnapshot
	state: RuntimeStateSnapshot
	reconciliation: readonly PluginReconciliationIssue[]
	sessionIntents: ReadonlyMap<string, RuntimePluginSessionEntry>
	desiredControl: ReadonlyMap<string, RuntimePluginDesiredControl>
	coreNodes: readonly PluginNodeAddress[]
	runningNodeKeys: ReadonlySet<string>
	recentUpdate: PluginRecentUpdateRead | undefined
}>

export interface RuntimeModuleCacheEntry {
	id: string
	exports: Record<string, unknown>
	aliases?: readonly string[]
}

export interface RuntimeModuleRuntime {
	normalizeId(moduleId: string): string
	moduleIdAliases(moduleId: string): Iterable<string>
	primeModuleCacheEntry(entry: RuntimeModuleCacheEntry): void
	dropModuleCacheEntries(ids: Iterable<string>): void
}

export type RuntimeRouteCapabilities = {
	recentUpdate?: PluginRecentUpdateRead
	modules?: RuntimeModuleRuntime
	dynamicPluginSources?: {
		hasFile(path: string): boolean
		hasDirectory(path: string, include: readonly string[]): boolean
	}
}

const identityModuleRuntime: RuntimeModuleRuntime = {
	normalizeId: (moduleId) => moduleId,
	moduleIdAliases: (moduleId) => [moduleId],
	primeModuleCacheEntry() {},
	dropModuleCacheEntries() {},
}

type RuntimeRouteInstallation = {
	readonly capabilities: RuntimeRouteCapabilities
	readonly previous: RuntimeRouteInstallation | undefined
	active: boolean
}

const routeCapabilities = new WeakMap<Context['root'], RuntimeRouteInstallation>()

/** @internal Installs one immutable host-owned route capability snapshot. */
export function installRuntimeRouteCapabilities(
	ctx: Context,
	capabilities: RuntimeRouteCapabilities,
): () => void {
	const root = ctx.root
	const installed: RuntimeRouteInstallation = {
		capabilities: Object.freeze({ ...capabilities }),
		previous: routeCapabilities.get(root),
		active: true,
	}
	routeCapabilities.set(root, installed)
	return (): void => {
		if (!installed.active) return
		installed.active = false
		if (routeCapabilities.get(root) !== installed) return
		let previous = installed.previous
		while (previous && !previous.active) previous = previous.previous
		if (previous) routeCapabilities.set(root, previous)
		else routeCapabilities.delete(root)
	}
}

/** @internal Read-only projection for runtime host integration. */
export function readRuntimeRouteCapabilities(ctx: Context): RuntimeRouteCapabilities | undefined {
	return routeCapabilities.get(ctx.root)?.capabilities
}

export function requireRouteCapability<K extends keyof RuntimeRouteCapabilities>(
	ctx: Context,
	key: K,
): NonNullable<RuntimeRouteCapabilities[K]> {
	const value = readRuntimeRouteCapabilities(ctx)?.[key]
	if (!value) {
		throw new Error(`[pluxel/runtime] Runtime route capability "${key}" is not available.`)
	}
	return value
}

export function runtimeModuleRuntime(ctx: Context): RuntimeModuleRuntime {
	return readRuntimeRouteCapabilities(ctx)?.modules ?? identityModuleRuntime
}

function createRuntimePluginStatusProjectionFromView(view: RuntimePluginStatusProjectionView) {
	const catalog = view.catalog
	const state = view.state
	const stateIndex = runtimeStateReadIndex(state)
	const issuesByNode = new Map<string, RuntimePluginStatusIssue[]>()
	for (const issue of view.reconciliation) {
		const projected = Object.freeze({
			id: pluginReconciliationIssueKey(issue),
			code: issue.kind,
			message: issue.message,
		})
		const touched = new Set<string>()
		const addresses: PluginNodeAddress[] = []
		if ('consumer' in issue) addresses.push(issue.consumer)
		if ('provider' in issue) addresses.push(issue.provider)
		if ('node' in issue) addresses.push(issue.node)
		for (const address of addresses) {
			const key = pluginNodeIndexKey(address)
			if (touched.has(key)) continue
			touched.add(key)
			const nodeIssues = issuesByNode.get(key)
			if (nodeIssues) nodeIssues.push(projected)
			else issuesByNode.set(key, [projected])
		}
	}
	return {
		catalog,
		state,
		stateIndex,
		issuesByNode: new Map(
			[...issuesByNode].map(([key, issues]) => [key, Object.freeze(issues)] as const),
		),
		runningNodeKeys: view.runningNodeKeys,
		sessionIntents: view.sessionIntents,
		desiredControl: view.desiredControl,
		coreNodes: view.coreNodes,
		recentUpdate: view.recentUpdate,
	}
}

function projectRuntimePluginStatus(
	entry: RuntimePluginCatalogEntry,
	projection: ReturnType<typeof createRuntimePluginStatusProjectionFromView>,
): RuntimePluginStatusSnapshot {
	const definition = projection.catalog.byDefinition.get(
		pluginDefinitionIndexKey(entry.address.definition),
	)
	const nodeKey = pluginNodeIndexKey(entry.address)
	const autoStart = projection.stateIndex.autoStartKeys.has(nodeKey)
	const sessionIntent = projection.sessionIntents.get(nodeKey)?.intent ?? 'inherit'
	const activationReason = projection.desiredControl.get(nodeKey)?.activationReason ?? null
	const lifecycleState = projection.runningNodeKeys.has(nodeKey) ? 'running' : 'stopped'
	const available =
		!!definition &&
		(entry.address.variant === 'default' ||
			(definition.candidate.declaration.forkable &&
				projection.stateIndex.forkNodeKeys.has(nodeKey)))
	const indexedIssues = projection.issuesByNode.get(nodeKey)
	const issues: RuntimePluginStatusIssue[] = indexedIssues ? [...indexedIssues] : []
	if (!available && issues.length === 0) {
		issues.push(
			Object.freeze({
				id: `definition_unavailable:${nodeKey}`,
				code: 'definition_unavailable',
				message: 'Plugin definition is unavailable in the route catalog',
			}),
		)
	}
	const recentUpdate = projection.recentUpdate?.resolveRecentUpdate(entry.address) ?? null
	return {
		...entry,
		autoStart,
		sessionIntent,
		desiredState: activationReason === null ? 'stopped' : 'running',
		activationReason,
		lifecycleState,
		availability: available ? 'available' : 'unavailable',
		issues: Object.freeze(issues),
		execution: definition?.provenance.execution ?? UNREPORTED_PLUGIN_EXECUTION,
		recentUpdate:
			recentUpdate === null
				? null
				: clonePluginRecentUpdateSnapshot(
						recentUpdate,
						`Recent update for ${pluginNodeIndexKey(entry.address)}`,
					),
	}
}

export async function readRuntimePluginStatusOverview(
	ctx: Context,
): Promise<RuntimePluginStatusOverview> {
	return await requireRuntimePluginGraphCoordinator(ctx).readCommitted((view) =>
		runtimePluginStatusOverviewFromView({
			catalog: view.catalog,
			state: view.runtimeState.state,
			reconciliation: view.reconciliation,
			sessionIntents: view.sessionIntents,
			desiredControl: view.desiredControl,
			coreNodes: view.coreAdjacency.nodes,
			runningNodeKeys: new Set(view.runningNodes.map(pluginNodeIndexKey)),
			recentUpdate: readRuntimeRouteCapabilities(ctx)?.recentUpdate,
		}),
	)
}

/** @internal Projects status exclusively from one coordinator-pinned committed view. */
export function runtimePluginStatusOverviewFromView(
	view: RuntimePluginStatusProjectionView,
): RuntimePluginStatusOverview {
	const projection = createRuntimePluginStatusProjectionFromView(view)
	const catalog = projection.catalog
	const state = projection.state
	const entries = new Map<string, RuntimePluginCatalogEntry>()
	const add = (address: PluginNodeAddress, displayName = address.definition.exportName): void => {
		const key = pluginNodeIndexKey(address)
		if (entries.has(key)) return
		entries.set(key, {
			address,
			displayName,
			rootExportName: address.definition.exportName,
		})
	}
	for (const entry of catalog.entries) {
		const declaration = entry.candidate.declaration
		add({ definition: declaration.address, variant: 'default' }, declaration.displayName)
		for (const forkId of projection.stateIndex.forkIdsByDefinition.get(
			pluginDefinitionIndexKey(declaration.address),
		) ?? []) {
			add({ definition: declaration.address, variant: 'fork', forkId }, declaration.displayName)
		}
	}
	for (const family of state.forks) {
		for (const forkId of family.forkIds)
			add({ definition: family.definition, variant: 'fork', forkId })
	}
	for (const address of state.autoStart) add(address)
	for (const entry of projection.sessionIntents.values()) add(entry.address)
	for (const entry of projection.desiredControl.values()) add(entry.address)
	for (const address of projection.coreNodes) add(address)
	for (const binding of state.providerDefaults) add(binding.provider)
	for (const binding of state.dependencyOverrides) {
		add(binding.consumerAddress)
		add(binding.providerAddress)
	}

	const statuses = [...entries.values()]
		.map((entry) => projectRuntimePluginStatus(entry, projection))
		.sort((left, right) =>
			pluginNodeIndexKey(left.address).localeCompare(pluginNodeIndexKey(right.address)),
		)
	let running = 0
	let autoStart = 0
	for (const status of statuses) {
		if (status.lifecycleState === 'running') running++
		if (status.autoStart) autoStart++
	}
	return {
		statuses,
		summary: {
			total: statuses.length,
			running,
			autoStart,
			stopped: statuses.length - running,
		},
	}
}
