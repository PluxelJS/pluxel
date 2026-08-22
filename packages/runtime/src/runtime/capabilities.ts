import {
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type Context,
	type PluginNodeAddress,
} from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import {
	pluginReconciliationIssueKey,
	requireRuntimePluginGraphCoordinator,
} from '../internal/reconciliation'
import { requireRuntimeStateStore } from '../internal/runtime-state'
import { runtimeStateReadIndex } from '../services/RuntimeStateHelpers'

export type RuntimePluginSource =
	| {
			__typename: 'PluginSourceInfo'
			kind: 'package'
			moduleId: string
			packageName: string
			version: string | null
			tag: string | null
	  }
	| {
			__typename: 'PluginSourceInfo'
			kind: 'hmr'
			moduleId: string
			packageName: null
			version: null
			tag: null
	  }
	| {
			__typename: 'PluginSourceInfo'
			kind: 'unknown'
			moduleId: null
			packageName: null
			version: null
			tag: null
	  }

export type RuntimePluginLifecycleStage = 'running' | 'stopped' | 'disabled'
export type RuntimePluginAvailability = 'available' | 'unavailable'
export type RuntimePluginReconciliationCode =
	| 'consumer_unavailable'
	| 'requirement_removed'
	| 'provider_unavailable'
	| 'provider_disabled'
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
	isRunning: boolean
	isEnabled: boolean
	lifecycleStage: RuntimePluginLifecycleStage
	availability: RuntimePluginAvailability
	issues: readonly RuntimePluginStatusIssue[]
	source: RuntimePluginSource
}

export type RuntimePluginStatusOverview = {
	statuses: RuntimePluginStatusSnapshot[]
	summary: { total: number; running: number; stopped: number; disabled: number }
}

export type RuntimePluginDependencyInfo = Array<{
	address: PluginNodeAddress
	displayName: string
	isRunning: boolean
}>

export interface PluginSourceRead {
	resolveSource(address: PluginNodeAddress): RuntimePluginSource
}

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
	source?: PluginSourceRead
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

export function unknownPluginSource(): RuntimePluginSource {
	return {
		__typename: 'PluginSourceInfo',
		kind: 'unknown',
		moduleId: null,
		packageName: null,
		version: null,
		tag: null,
	}
}

export function readRuntimePluginStatus(
	ctx: Context,
	entry: RuntimePluginCatalogEntry,
): RuntimePluginStatusSnapshot {
	return projectRuntimePluginStatus(entry, createRuntimePluginStatusProjection(ctx))
}

function createRuntimePluginStatusProjection(ctx: Context) {
	const coordinator = requireRuntimePluginGraphCoordinator(ctx)
	const catalog = coordinator.catalogSnapshot()
	const state = requireRuntimeStateStore(ctx).snapshot()
	const stateIndex = runtimeStateReadIndex(state)
	const issuesByNode = new Map<string, RuntimePluginStatusIssue[]>()
	for (const issue of coordinator.reconciliationIssues()) {
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
		pluginService: requirePluginService(ctx),
		source: readRuntimeRouteCapabilities(ctx)?.source,
	}
}

function projectRuntimePluginStatus(
	entry: RuntimePluginCatalogEntry,
	projection: ReturnType<typeof createRuntimePluginStatusProjection>,
): RuntimePluginStatusSnapshot {
	const definition = projection.catalog.byDefinition.get(
		pluginDefinitionIndexKey(entry.address.definition),
	)
	const nodeKey = pluginNodeIndexKey(entry.address)
	const isRunning = projection.pluginService.isRunning(entry.address)
	const isEnabled = projection.stateIndex.enabledKeys.has(nodeKey)
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
	return {
		...entry,
		isRunning,
		isEnabled,
		lifecycleStage: !isEnabled ? 'disabled' : isRunning ? 'running' : 'stopped',
		availability: available ? 'available' : 'unavailable',
		issues: Object.freeze(issues),
		source: projection.source?.resolveSource(entry.address) ?? unknownPluginSource(),
	}
}

export function runtimePluginStatusOverview(ctx: Context): RuntimePluginStatusOverview {
	const projection = createRuntimePluginStatusProjection(ctx)
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
	for (const address of state.enabled) add(address)
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
	let disabled = 0
	for (const status of statuses) {
		if (status.isRunning) running++
		if (!status.isEnabled) disabled++
	}
	return {
		statuses,
		summary: {
			total: statuses.length,
			running,
			disabled,
			stopped: statuses.length - running - disabled,
		},
	}
}
