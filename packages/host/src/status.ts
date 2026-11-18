import {
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	parsePluginNodeAddress,
	type Context,
	type PluginDefinitionAddress,
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
	| 'control_analysis_failed'
	| 'control_source_changed'
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

export type HostPluginControlSnapshot = {
	autoStart: boolean
	sessionIntent: PluginSessionIntent
	desiredState: 'running' | 'stopped'
	activationReason: PluginActivationReason | null
	lifecycleState: 'running' | 'stopped'
}

export type HostPluginStatusSnapshot = HostPluginCatalogEntry &
	HostPluginControlSnapshot & {
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

/** @internal Native identity and control facts, without display diagnostics or recent updates. */
export type HostPluginControlProjectionView = Readonly<{
	catalog: PluginCatalogSnapshot
	declaredNodes?: ReadonlyMap<string, PluginNodeAddress>
	state: HostStateSnapshot
	sessionIntents: ReadonlyMap<string, HostPluginSessionEntry>
	desiredControl: ReadonlyMap<string, HostPluginDesiredControl>
	coreNodes: readonly PluginNodeAddress[]
	runningNodeKeys: ReadonlySet<string>
}>

/** @internal Fixed inputs shared by status and dependency-graph projection. */
export type HostPluginStatusProjectionView = HostPluginControlProjectionView &
	Readonly<{
		reconciliation: readonly PluginReconciliationIssue[]
		lifecycleIssues?: readonly import('./diagnostics').HostPluginLifecycleDiagnostic[]
		recentUpdate: PluginRecentUpdateRead | undefined
	}>

function createHostPluginStatusProjectionFromView(
	view: HostPluginStatusProjectionView,
	targetKeys?: ReadonlySet<string>,
) {
	const catalog = view.catalog
	const state = view.state
	const stateIndex = hostStateReadIndex(state)
	const issuesByNode = new Map<string, HostPluginStatusIssue[]>()
	for (const issue of view.reconciliation) {
		const addresses: PluginNodeAddress[] = []
		if ('consumer' in issue && issue.consumer !== undefined) addresses.push(issue.consumer)
		if ('provider' in issue) addresses.push(issue.provider)
		if ('node' in issue) addresses.push(issue.node)
		if (targetKeys && !addresses.some((address) => targetKeys.has(pluginNodeIndexKey(address))))
			continue
		const projected = Object.freeze({
			id: pluginReconciliationIssueKey(issue),
			code: issue.kind,
			message: issue.message,
		})
		const touched = new Set<string>()
		for (const address of addresses) {
			const key = pluginNodeIndexKey(address)
			if (targetKeys && !targetKeys.has(key)) continue
			if (touched.has(key)) continue
			touched.add(key)
			const nodeIssues = issuesByNode.get(key)
			if (nodeIssues) nodeIssues.push(projected)
			else issuesByNode.set(key, [projected])
		}
	}
	for (const issue of view.lifecycleIssues ?? []) {
		const key = pluginNodeIndexKey(issue.plugin)
		if (targetKeys && !targetKeys.has(key)) continue
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
	const available =
		!!definition &&
		(entry.address.variant === 'default' ||
			(definition.candidate.declaration.forkable &&
				projection.stateIndex.forkNodeKeys.has(nodeKey)))
	const indexedIssues = projection.issuesByNode.get(nodeKey)
	const issues: HostPluginStatusIssue[] = indexedIssues ? [...indexedIssues] : []
	if (!definition && issues.length === 0) {
		issues.push(
			Object.freeze({
				id: `definition_unavailable:${nodeKey}`,
				code: 'definition_unavailable',
				message: 'Plugin definition is unavailable in the route catalog',
			}),
		)
	}
	const control = definition?.provenance.control
	if (
		control?.state === 'unavailable' &&
		(control.reason === 'analysis_failed' || control.reason === 'source_changed')
	) {
		issues.push(
			Object.freeze({
				id: `control:${nodeKey}:${control.reason}`,
				code:
					control.reason === 'analysis_failed'
						? 'control_analysis_failed'
						: 'control_source_changed',
				message:
					control.message ??
					(control.reason === 'analysis_failed'
						? 'Plugin control declaration analysis failed'
						: 'Plugin control declarations differ from the evaluated implementation input'),
			}),
		)
	}
	const recentUpdate = projection.recentUpdate?.resolveRecentUpdate(entry.address) ?? null
	return {
		...entry,
		...projectHostPluginControl(projection, nodeKey),
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

function projectHostPluginControl(
	view: Pick<
		HostPluginControlProjectionView,
		'state' | 'sessionIntents' | 'desiredControl' | 'runningNodeKeys'
	>,
	nodeKey: string,
): HostPluginControlSnapshot {
	const activationReason = view.desiredControl.get(nodeKey)?.activationReason ?? null
	return {
		autoStart: hostStateReadIndex(view.state).autoStartKeys.has(nodeKey),
		sessionIntent: view.sessionIntents.get(nodeKey)?.intent ?? 'inherit',
		desiredState: activationReason === null ? 'stopped' : 'running',
		activationReason,
		lifecycleState: view.runningNodeKeys.has(nodeKey) ? 'running' : 'stopped',
	}
}

export async function readHostPluginStatusOverview(
	ctx: Context,
	recentUpdate?: PluginRecentUpdateRead,
): Promise<HostPluginStatusOverview> {
	return await requirePluginHostCoordinator(ctx).readCommitted((view) =>
		hostPluginStatusOverviewFromView({
			catalog: view.catalog,
			declaredNodes: view.declaredNodes,
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

/** Read one known node from one committed view without projecting or sorting the catalog. */
export async function readHostPluginStatus(
	ctx: Context,
	address: PluginNodeAddress,
	recentUpdate?: PluginRecentUpdateRead,
): Promise<HostPluginStatusSnapshot | null> {
	return await requirePluginHostCoordinator(ctx).readCommitted((view) =>
		hostPluginStatusFromView(
			{
				catalog: view.catalog,
				declaredNodes: view.declaredNodes,
				state: view.runtimeState.state,
				reconciliation: view.reconciliation,
				lifecycleIssues: readHostPluginLifecycleIssues(ctx),
				sessionIntents: view.sessionIntents,
				desiredControl: view.desiredControl,
				coreNodes: view.coreAdjacency.nodes,
				runningNodeKeys: new Set(view.runningNodes.map(pluginNodeIndexKey)),
				recentUpdate: recentUpdate ?? readHostRecentUpdates(ctx),
			},
			address,
		),
	)
}

/** @internal The exact counterpart of overview, using the same node projection. */
export function hostPluginStatusFromView(
	view: HostPluginStatusProjectionView,
	address: PluginNodeAddress,
): HostPluginStatusSnapshot | null {
	const entry = hostPluginCatalogEntryFromView(view, address)
	return entry
		? projectHostPluginStatus(
				entry,
				createHostPluginStatusProjectionFromView(
					view,
					new Set([pluginNodeIndexKey(entry.address)]),
				),
			)
		: null
}

/** @internal Read a mutation receipt's control state without presentation inventory or diagnostics. */
export function hostPluginControlFromView(
	view: HostPluginControlProjectionView,
	address: PluginNodeAddress,
): HostPluginControlSnapshot | null {
	const entry = hostPluginCatalogEntryFromView(view, address)
	return entry ? projectHostPluginControl(view, pluginNodeIndexKey(entry.address)) : null
}

function hostPluginCatalogEntryFromView(
	view: HostPluginControlProjectionView,
	address: PluginNodeAddress,
): HostPluginCatalogEntry | null {
	const selectedAddress = parsePluginNodeAddress(address)
	const key = pluginNodeIndexKey(selectedAddress)
	const definition = view.catalog.byDefinition.get(
		pluginDefinitionIndexKey(selectedAddress.definition),
	)
	const stateIndex = hostStateReadIndex(view.state)
	const declared =
		!!definition && (selectedAddress.variant === 'default' || stateIndex.forkNodeKeys.has(key))
	const matches = (candidate: PluginNodeAddress) => pluginNodeIndexKey(candidate) === key
	if (
		!declared &&
		!view.declaredNodes?.has(key) &&
		!stateIndex.forkNodeKeys.has(key) &&
		!stateIndex.autoStartKeys.has(key) &&
		!view.sessionIntents.has(key) &&
		!view.desiredControl.has(key) &&
		!view.coreNodes.some(matches) &&
		!view.state.providerDefaults.some((binding) => matches(binding.provider)) &&
		!view.state.dependencyOverrides.some(
			(binding) => matches(binding.consumerAddress) || matches(binding.providerAddress),
		)
	)
		return null
	return {
		address: selectedAddress,
		displayName: declared
			? definition.candidate.declaration.displayName
			: selectedAddress.definition.exportName,
		rootExportName: selectedAddress.definition.exportName,
	}
}

/** @internal Projects status exclusively from one coordinator-pinned committed view. */
export function hostPluginStatusOverviewFromView(
	view: HostPluginStatusProjectionView,
): HostPluginStatusOverview {
	const projection = createHostPluginStatusProjectionFromView(view)
	const statuses = hostPluginCatalogEntriesFromView(view)
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

/** @internal Projects a selected identity page, sharing the overview's status authority. */
export function hostPluginStatusesFromView(
	view: HostPluginStatusProjectionView,
	entries: readonly HostPluginCatalogEntry[],
): HostPluginStatusSnapshot[] {
	const projection = createHostPluginStatusProjectionFromView(
		view,
		new Set(entries.map((entry) => pluginNodeIndexKey(entry.address))),
	)
	return entries.map((entry) => projectHostPluginStatus(entry, projection))
}

/** @internal Enumerates node identity and labels without projecting runtime state. */
export function hostPluginCatalogEntriesFromView(
	view: HostPluginStatusProjectionView,
	query: Readonly<{ definition?: PluginDefinitionAddress; packageName?: string }> = {},
): HostPluginCatalogEntry[] {
	const state = view.state
	const stateIndex = hostStateReadIndex(state)
	const entries = new Map<string, HostPluginCatalogEntry>()
	const definitionKey = query.definition && pluginDefinitionIndexKey(query.definition)
	const add = (address: PluginNodeAddress, displayName = address.definition.exportName): void => {
		if (definitionKey && pluginDefinitionIndexKey(address.definition) !== definitionKey) return
		const entry = address.definition.entry
		if (
			query.packageName !== undefined &&
			(entry.kind === 'source-entry' || entry.packageName !== query.packageName)
		)
			return
		const key = pluginNodeIndexKey(address)
		if (entries.has(key)) return
		entries.set(key, {
			address,
			displayName,
			rootExportName: address.definition.exportName,
		})
	}
	const selected = definitionKey ? view.catalog.byDefinition.get(definitionKey) : undefined
	const definitions = definitionKey ? (selected ? [selected] : []) : view.catalog.entries
	for (const entry of definitions) {
		const declaration = entry.candidate.declaration
		add({ definition: declaration.address, variant: 'default' }, declaration.displayName)
		for (const forkId of stateIndex.forkIdsByDefinition.get(
			pluginDefinitionIndexKey(declaration.address),
		) ?? []) {
			add({ definition: declaration.address, variant: 'fork', forkId }, declaration.displayName)
		}
	}
	for (const address of state.forks) add(address)
	for (const address of view.declaredNodes?.values() ?? []) add(address)
	for (const address of state.autoStart) add(address)
	for (const entry of view.sessionIntents.values()) add(entry.address)
	for (const entry of view.desiredControl.values()) add(entry.address)
	for (const address of view.coreNodes) add(address)
	for (const binding of state.providerDefaults) add(binding.provider)
	for (const binding of state.dependencyOverrides) {
		add(binding.consumerAddress)
		add(binding.providerAddress)
	}

	return [...entries.values()]
}
