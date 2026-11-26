import {
	parsePluginDefinitionAddress,
	pluginDefinitionIndexKey,
	pluginNodeAddressEqual,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	parsePluginControlDependencyFacts,
	type PluginControlDependencies,
} from '@pluxel/core/internal/control-manifest'
import { normalize } from 'node:path'
import { extendPluginDefinitionRoleHistory, PluginCatalogError } from './catalog'
import type { HostPluginGraphCommittedView } from './coordinator'
import {
	type PolicyDeclaration,
	livePolicyRejections,
	pluginReconciliationIssueKey,
	selectedRequiredBindings,
	selectPluginGraph,
	type PluginReconciliationIssue,
} from './reconcile'

export type PluginSourceDefinition = Readonly<{
	address: PluginDefinitionAddress
	dependencies?: PluginControlDependencies
}>

export type PluginSourcePublication = Readonly<{ name: string; file: string }> &
	(
		| Readonly<{ action: 'withdraw' }>
		| Readonly<{
				action: 'publish'
				definitions: readonly PluginSourceDefinition[] | undefined
		  }>
	)

type MissingFact = Readonly<{
	packageName: string
	definition?: PluginDefinitionAddress
	reason: 'exports' | 'dependencies' | 'forkability' | 'source-ownership'
}>

/** Policy projection over declared package roots and retained catalog definitions. A newly introduced foreign re-export is discovered at load time. */
export type PluginSourceDependencyReview =
	| Readonly<{ status: 'incomplete'; missing: readonly MissingFact[] }>
	| Readonly<{ status: 'invalid'; code: PluginCatalogError['code']; message: string }>
	| Readonly<{
			status: 'projected'
			/** Candidate declarations without any matching provider in the projected catalog, including inactive definitions. */
			unprovided: readonly Readonly<{
				definition: PluginDefinitionAddress
				requirement: PluginDefinitionAddress
				kind: 'required' | 'optional'
			}>[]
			/** A live replacement with these issues keeps the committed catalog. */
			liveRejections: readonly PluginReconciliationIssue[]
			introduced: readonly PluginReconciliationIssue[]
			resolved: readonly PluginReconciliationIssue[]
			/** Changes to required bindings among nodes selected by current Host policy. */
			bindings: readonly Readonly<{
				consumer: PluginNodeAddress
				requirement: PluginDefinitionAddress
				previous: PluginNodeAddress | null
				selected: PluginNodeAddress | null
			}>[]
	  }>

type PolicyProjection = Extract<PluginSourceDependencyReview, { status: 'projected' }>

/** Project changes to declared roots together. Foreign re-exports exclusively supplied by a changing publisher have no candidate declaration. */
export function reviewSourceDependencies(
	view: HostPluginGraphCommittedView,
	sources: readonly PluginSourcePublication[],
): PluginSourceDependencyReview {
	const current = view.catalog.declarations
	const next = new Map<string, PolicyDeclaration>(current)
	const changing = new Map(sources.map((source) => [normalize(source.file), source]))
	const missing: MissingFact[] = []
	const byName = new Map(sources.map((source) => [source.name, source]))
	for (const entry of view.catalog.entries) {
		const files = entry.provenance.sourceFiles ?? []
		const affected = files
			.map((file) => changing.get(normalize(file)))
			.filter((source) => source !== undefined)
		const origin = entry.provenance.execution
		if (origin?.kind === 'unreported' || !origin) {
			const owners = new Set(affected)
			const owner =
				entry.address.entry.kind !== 'source-entry' && byName.get(entry.address.entry.packageName)
			if (owner) owners.add(owner)
			for (const { name } of owners)
				missing.push({ packageName: name, definition: entry.address, reason: 'source-ownership' })
			if (owners.size > 0) next.delete(entry.indexKey)
			continue
		}
		if (affected.length === 0 || files.length > affected.length || origin.origin === 'fixed')
			continue
		for (const source of affected) {
			if (
				source.action === 'publish' &&
				!(
					entry.address.entry.kind === 'package-root' &&
					entry.address.entry.packageName === source.name
				)
			) {
				missing.push({
					packageName: source.name,
					definition: entry.address,
					reason: 'source-ownership',
				})
			}
		}
		next.delete(entry.indexKey)
	}
	const proposed = new Map<string, PolicyDeclaration>()
	const forks = new Set(
		view.runtimeState.state.forks.map((node) => pluginDefinitionIndexKey(node.definition)),
	)
	for (const source of sources) {
		if (source.action === 'withdraw') continue
		if (source.definitions === undefined) {
			missing.push({ packageName: source.name, reason: 'exports' })
			continue
		}
		if (!Array.isArray(source.definitions))
			throw new TypeError('[host/sources] published definitions must be an array')
		const seen = new Set<string>()
		for (const { address, dependencies } of source.definitions) {
			const definition = parsePluginDefinitionAddress(address)
			const key = pluginDefinitionIndexKey(definition)
			if (
				definition.entry.kind !== 'package-root' ||
				definition.entry.packageName !== source.name ||
				seen.has(key)
			)
				throw new TypeError(
					'[host/sources] each published definition must identify a distinct export at its package root',
				)
			seen.add(key)
			if (next.has(key))
				missing.push({ packageName: source.name, definition, reason: 'source-ownership' })
			if (dependencies === undefined) {
				missing.push({ packageName: source.name, definition, reason: 'dependencies' })
				continue
			}
			const declaration = {
				...parsePluginControlDependencyFacts(dependencies),
				address: definition,
			}
			if (forks.has(key) && declaration.forkable === undefined)
				missing.push({ packageName: source.name, definition, reason: 'forkability' })
			next.set(key, declaration)
			proposed.set(key, declaration)
		}
	}
	if (missing.length > 0) return { status: 'incomplete', missing }
	try {
		extendPluginDefinitionRoleHistory(view.definitionRoles, next.values())
	} catch (error) {
		if (error instanceof PluginCatalogError)
			return { status: 'invalid', code: error.code, message: error.message }
		throw error
	}
	const projected = selectPluginGraph({
		declarations: next,
		runtimeState: view.runtimeState.state,
		sessionIntents: view.sessionIntents,
	})
	const available = new Set(next.keys())
	for (const declaration of next.values())
		if (declaration.provides) available.add(pluginDefinitionIndexKey(declaration.provides))
	const unprovided: PolicyProjection['unprovided'][number][] = []
	for (const { address: definition, requires, optional } of proposed.values()) {
		for (const requirement of requires) {
			if (!available.has(pluginDefinitionIndexKey(requirement)))
				unprovided.push({ definition, requirement, kind: 'required' })
		}
		for (const requirement of optional) {
			if (!next.has(pluginDefinitionIndexKey(requirement)))
				unprovided.push({ definition, requirement, kind: 'optional' })
		}
	}
	const previousIssues = new Set(view.reconciliation.map(pluginReconciliationIssueKey))
	const nextIssues = new Set(projected.blocked.map(pluginReconciliationIssueKey))
	const before = selectedRequiredBindings(current, view.applied)
	const after = selectedRequiredBindings(next, projected)
	const bindings: PolicyProjection['bindings'][number][] = []
	for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
		const previous = before.get(key)
		const selected = after.get(key)
		if (previous && selected && pluginNodeAddressEqual(previous.provider, selected.provider))
			continue
		const { consumer, requirement } = (selected ?? previous)!
		bindings.push({
			consumer,
			requirement,
			previous: previous?.provider ?? null,
			selected: selected?.provider ?? null,
		})
	}
	return {
		status: 'projected',
		unprovided,
		liveRejections: livePolicyRejections(new Set(proposed.keys()), projected.blocked),
		introduced: projected.blocked.filter(
			(issue) => !previousIssues.has(pluginReconciliationIssueKey(issue)),
		),
		resolved: view.reconciliation.filter(
			(issue) => !nextIssues.has(pluginReconciliationIssueKey(issue)),
		),
		bindings,
	}
}
