import {
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type Context,
	type PluginNodeAddress,
} from '@pluxel/core'
import { readHostRecentUpdates } from './recent-update'
import { requirePluginHostCoordinator } from './install'
import { readHostPluginLifecycleIssues } from './diagnostics'
import type { HostStateSnapshot } from './policy'
import { hostStateReadIndex } from './state-helpers'
import type { PluginCatalogSnapshot } from './catalog'
import {
	pluginReconciliationIssueKey,
	type PluginActivationReason,
	type PluginReconciliationIssue,
	type PluginSessionIntent,
	type HostPluginDesiredControl,
	type HostPluginSessionEntry,
} from './reconcile'
import {
	clonePluginRecentUpdateSnapshot,
	UNREPORTED_PLUGIN_EXECUTION,
	type PluginExecutionSnapshot,
	type PluginRecentUpdateSnapshot,
	type RuntimeUpdateSnapshot,
} from './execution'
export type HostPluginAvailability = 'available' | 'unavailable'
export type HostPluginReconciliationCode =
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
	| 'resolve-failed'
	| 'config-failed'
	| 'start-failed'
	| 'dependency-blocked'
	| 'drain-failed'
export type HostPluginStatusIssue = Readonly<{
	id: string
	code: HostPluginReconciliationCode
	message: string
}>

export type HostPluginCatalogEntry = Readonly<{
	address: PluginNodeAddress
	displayName: string
	rootExportName: string
}>

export type HostPluginStatusSnapshot = HostPluginCatalogEntry & {
	autoStart: boolean
	sessionIntent: PluginSessionIntent
	desiredState: 'running' | 'stopped'
	activationReason: PluginActivationReason | null
	lifecycleState: 'running' | 'stopped'
	availability: HostPluginAvailability
	issues: readonly HostPluginStatusIssue[]
	execution: PluginExecutionSnapshot
	recentUpdate: PluginRecentUpdateSnapshot | null
}

export type HostPluginStatusOverview = {
	statuses: HostPluginStatusSnapshot[]
	summary: { total: number; running: number; stopped: number; autoStart: number }
}

export interface PluginRecentUpdateRead {
	latestUpdate?(): RuntimeUpdateSnapshot | null
	subscribeUpdates?(observer: (snapshot: RuntimeUpdateSnapshot | null) => void): () => void
	resolveRecentUpdate(address: PluginNodeAddress): PluginRecentUpdateSnapshot | null
}

/** @internal Fixed inputs shared by status and dependency-graph projection. */
export type HostPluginStatusProjectionView = Readonly<{
	catalog: PluginCatalogSnapshot
	state: HostStateSnapshot
	reconciliation: readonly PluginReconciliationIssue[]
	lifecycleIssues?: readonly import('./diagnostics').HostPluginLifecycleDiagnostic[]
	sessionIntents: ReadonlyMap<string, HostPluginSessionEntry>
	desiredControl: ReadonlyMap<string, HostPluginDesiredControl>
	coreNodes: readonly PluginNodeAddress[]
	runningNodeKeys: ReadonlySet<string>
	recentUpdate: PluginRecentUpdateRead | undefined
}>

function createHostPluginStatusProjectionFromView(view: HostPluginStatusProjectionView) {
	const catalog = view.catalog
	const state = view.state
	const stateIndex = hostStateReadIndex(state)
	const issuesByNode = new Map<string, HostPluginStatusIssue[]>()
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
	for (const issue of view.lifecycleIssues ?? []) {
		const key = pluginNodeIndexKey(issue.plugin)
		const issues = issuesByNode.get(key) ?? []
		issues.push(
			Object.freeze({
				id: `lifecycle:${key}:${issue.kind}`,
				code: issue.kind,
				message: issue.message,
			}),
		)
		issuesByNode.set(key, issues)
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

function projectHostPluginStatus(
	entry: HostPluginCatalogEntry,
	projection: ReturnType<typeof createHostPluginStatusProjectionFromView>,
): HostPluginStatusSnapshot {
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
	const issues: HostPluginStatusIssue[] = indexedIssues ? [...indexedIssues] : []
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

export async function readHostPluginStatusOverview(
	ctx: Context,
	recentUpdate?: PluginRecentUpdateRead,
): Promise<HostPluginStatusOverview> {
	return await requirePluginHostCoordinator(ctx).readCommitted((view) =>
		hostPluginStatusOverviewFromView({
			catalog: view.catalog,
			state: view.runtimeState.state,
			reconciliation: view.reconciliation,
			lifecycleIssues: readHostPluginLifecycleIssues(ctx),
			sessionIntents: view.sessionIntents,
			desiredControl: view.desiredControl,
			coreNodes: view.coreAdjacency.nodes,
			runningNodeKeys: new Set(view.runningNodes.map(pluginNodeIndexKey)),
			recentUpdate: recentUpdate ?? readHostRecentUpdates(ctx),
		}),
	)
}

/** @internal Projects status exclusively from one coordinator-pinned committed view. */
export function hostPluginStatusOverviewFromView(
	view: HostPluginStatusProjectionView,
): HostPluginStatusOverview {
	const projection = createHostPluginStatusProjectionFromView(view)
	const catalog = projection.catalog
	const state = projection.state
	const entries = new Map<string, HostPluginCatalogEntry>()
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
		.map((entry) => projectHostPluginStatus(entry, projection))
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
