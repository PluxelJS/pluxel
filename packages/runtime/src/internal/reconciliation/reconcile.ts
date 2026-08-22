import {
	formatPluginDefinitionReference,
	formatPluginNodeReference,
	pluginDefinitionAddressEqual,
	pluginDefinitionIndexKey,
	pluginNodeAddressEqual,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import type { ConcretePluginDefinitionCandidate } from '@pluxel/core/internal'
import type { RuntimeStateSnapshot } from '../../services/RuntimeStateStore'
import {
	pluginCatalogEntry,
	type PluginRouteCatalogEntry,
	type PluginRouteCatalogSnapshot,
} from './catalog'
import { runtimeStatePatch, type RuntimeStatePatch } from './state'

export type PluginReconciliationIssue =
	| Readonly<{
			kind: 'consumer_unavailable'
			consumer: PluginNodeAddress
			message: string
	  }>
	| Readonly<{
			kind: 'requirement_removed'
			binding: 'dependency-override'
			consumer: PluginNodeAddress
			requirement: PluginDefinitionAddress
			provider: PluginNodeAddress
			message: string
	  }>
	| Readonly<{
			kind: 'provider_unavailable' | 'provider_disabled' | 'provider_incompatible'
			binding: 'provider-default' | 'dependency-override'
			consumer?: PluginNodeAddress
			requirement: PluginDefinitionAddress
			provider: PluginNodeAddress
			message: string
	  }>
	| Readonly<{
			kind: 'fork_not_allowed'
			node: PluginNodeAddress
			message: string
	  }>
	| Readonly<{
			kind: 'fork_default_forbidden'
			requirement: PluginDefinitionAddress
			provider: PluginNodeAddress
			message: string
	  }>
	| Readonly<{
			kind: 'provider_default_requires_abstract'
			requirement: PluginDefinitionAddress
			provider: PluginNodeAddress
			message: string
	  }>
	| Readonly<{
			kind: 'explicit_binding_invalid'
			binding: 'provider-default' | 'dependency-override'
			consumer?: PluginNodeAddress
			requirement: PluginDefinitionAddress
			provider: PluginNodeAddress
			message: string
	  }>
	| Readonly<{
			kind: 'missing_required_provider'
			consumer: PluginNodeAddress
			requirement: PluginDefinitionAddress
			message: string
	  }>

export type CorePluginOperation =
	| Readonly<{
			type: 'materialize-node'
			address: PluginNodeAddress
			candidate: ConcretePluginDefinitionCandidate
	  }>
	| Readonly<{
			type: 'dematerialize-node'
			address: PluginNodeAddress
			cascadeDependents: true
	  }>
	| Readonly<{
			type: 'restart-node'
			address: PluginNodeAddress
			cascadeDependents: true
	  }>
	| Readonly<{
			type: 'replace-definition'
			address: PluginDefinitionAddress
			candidate: ConcretePluginDefinitionCandidate
			cascadeDependents: true
	  }>
	| Readonly<{
			type: 'set-provider-default'
			token: PluginDefinitionAddress
			provider: PluginNodeAddress | null
	  }>
	| Readonly<{
			type: 'set-dependency-override'
			consumer: PluginNodeAddress
			requirement: PluginDefinitionAddress
			provider: PluginNodeAddress | null
	  }>

type AppliedNode = Readonly<{
	address: PluginNodeAddress
	candidate: ConcretePluginDefinitionCandidate
}>

export type AppliedPluginGraphSnapshot = Readonly<{
	nodes: ReadonlyMap<string, AppliedNode>
	providerDefaults: ReadonlyMap<
		string,
		Readonly<{
			token: PluginDefinitionAddress
			provider: PluginNodeAddress
		}>
	>
	dependencyOverrides: ReadonlyMap<
		string,
		Readonly<{
			consumer: PluginNodeAddress
			requirement: PluginDefinitionAddress
			provider: PluginNodeAddress
		}>
	>
}>

export type ReconciliationPlan = Readonly<{
	catalogRevision: number
	runtimeStateRevision: number
	statePatch?: RuntimeStatePatch
	coreOperations: readonly CorePluginOperation[]
	blocked: readonly PluginReconciliationIssue[]
	applied: AppliedPluginGraphSnapshot
}>

export function emptyAppliedPluginGraphSnapshot(): AppliedPluginGraphSnapshot {
	return Object.freeze({
		nodes: new Map(),
		providerDefaults: new Map(),
		dependencyOverrides: new Map(),
	})
}

export function reconcilePluginGraph(input: {
	catalog: PluginRouteCatalogSnapshot
	runtimeState: RuntimeStateSnapshot
	runtimeStateRevision: number
	applied?: AppliedPluginGraphSnapshot
}): ReconciliationPlan {
	const applied = input.applied ?? emptyAppliedPluginGraphSnapshot()
	const issues: PluginReconciliationIssue[] = []
	const issueKeys = new Set<string>()
	const blocked = new Set<string>()
	const enabled = new Map(
		input.runtimeState.enabled.map((address) => [pluginNodeIndexKey(address), address]),
	)
	const durableForks = durableForkIndex(input.runtimeState)
	const candidates = candidateNodes(input.catalog, input.runtimeState, issues, issueKeys, blocked)

	for (const [key, address] of enabled) {
		if (candidates.has(key)) continue
		addIssue(issues, issueKeys, {
			kind: 'consumer_unavailable',
			consumer: address,
			message: `Plugin node is enabled but unavailable: ${formatPluginNodeReference(address)}`,
		})
		blocked.add(key)
	}

	const providerDefaults = resolveProviderDefaults({
		catalog: input.catalog,
		state: input.runtimeState,
		enabled,
		durableForks,
		issues,
		issueKeys,
	})
	const inferredPatch =
		providerDefaults.inferred.length === 0
			? undefined
			: runtimeStatePatch(
					...providerDefaults.inferred.map((entry) => ({
						type: 'set-provider-default' as const,
						token: entry.token,
						provider: entry.provider,
					})),
				)

	const validOverrides = new Map<string, ResolvedOverride>()
	for (const override of input.runtimeState.dependencyOverrides) {
		const consumerKey = pluginNodeIndexKey(override.consumerAddress)
		const consumer = candidates.get(consumerKey)
		const consumerEnabled = enabled.has(consumerKey)
		if (!consumer) {
			addIssue(issues, issueKeys, {
				kind: 'consumer_unavailable',
				consumer: override.consumerAddress,
				message: `Dependency override consumer is unavailable: ${formatPluginNodeReference(override.consumerAddress)}`,
			})
			if (consumerEnabled) blocked.add(consumerKey)
			continue
		}
		if (!hasRequirement(consumer.entry, override.requirementAddress)) {
			addIssue(issues, issueKeys, {
				kind: 'requirement_removed',
				binding: 'dependency-override',
				consumer: override.consumerAddress,
				requirement: override.requirementAddress,
				provider: override.providerAddress,
				message: `Dependency requirement no longer exists: ${formatPluginDefinitionReference(override.requirementAddress)}`,
			})
			if (consumerEnabled) blocked.add(consumerKey)
			continue
		}
		const providerIssue = validateProvider({
			catalog: input.catalog,
			enabled,
			durableForks,
			binding: 'dependency-override',
			consumer: override.consumerAddress,
			requirement: override.requirementAddress,
			provider: override.providerAddress,
		})
		if (providerIssue) {
			addIssue(issues, issueKeys, providerIssue)
			if (consumerEnabled) blocked.add(consumerKey)
			continue
		}
		if (!consumerEnabled) continue
		validOverrides.set(overrideKey(override.consumerAddress, override.requirementAddress), {
			consumer: override.consumerAddress,
			requirement: override.requirementAddress,
			provider: override.providerAddress,
		})
	}

	propagateBlockedDependencies({
		catalog: input.catalog,
		candidates,
		enabled,
		blocked,
		providerDefaults: providerDefaults.effective,
		validOverrides,
		issues,
		issueKeys,
	})

	const desiredNodes = new Map<string, AppliedNode>()
	for (const [key, node] of candidates) {
		if (!enabled.has(key) || blocked.has(key)) continue
		desiredNodes.set(key, Object.freeze({ address: node.address, candidate: node.entry.candidate }))
	}

	const desiredProviderDefaults = new Map<
		string,
		{
			token: PluginDefinitionAddress
			provider: PluginNodeAddress
		}
	>()
	for (const [key, value] of providerDefaults.effective) {
		if (!desiredNodes.has(pluginNodeIndexKey(value.provider))) continue
		desiredProviderDefaults.set(key, value)
	}

	const desiredOverrides = new Map<string, ResolvedOverride>()
	for (const [key, value] of validOverrides) {
		if (
			desiredNodes.has(pluginNodeIndexKey(value.consumer)) &&
			desiredNodes.has(pluginNodeIndexKey(value.provider))
		) {
			desiredOverrides.set(key, value)
		}
	}

	const nextApplied: AppliedPluginGraphSnapshot = Object.freeze({
		nodes: desiredNodes,
		providerDefaults: desiredProviderDefaults,
		dependencyOverrides: desiredOverrides,
	})
	const operations = diffAppliedGraph(applied, nextApplied)
	return Object.freeze({
		catalogRevision: input.catalog.revision,
		runtimeStateRevision: input.runtimeStateRevision,
		...(inferredPatch ? { statePatch: inferredPatch } : {}),
		coreOperations: Object.freeze(operations),
		blocked: Object.freeze(sortIssues(issues)),
		applied: nextApplied,
	})
}

/**
 * Selects desired-policy issues that make a live catalog transition unsafe.
 * Cold boot keeps the same issues as blocked projection; a live process keeps its
 * last-known-good catalog instead of invalidating explicit state or half-replacing a definition.
 */
export function catalogTransitionRejections(input: {
	previous: PluginRouteCatalogSnapshot
	next: PluginRouteCatalogSnapshot
	plan: ReconciliationPlan
}): readonly PluginReconciliationIssue[] {
	const changed = new Set<string>()
	for (const entry of input.next.entries) {
		const previous = input.previous.byDefinition.get(entry.indexKey)
		if (!previous || previous.candidate !== entry.candidate) changed.add(entry.indexKey)
	}
	const removed = new Set(
		input.previous.entries
			.filter((entry) => !input.next.byDefinition.has(entry.indexKey))
			.map((entry) => entry.indexKey),
	)
	return Object.freeze(
		input.plan.blocked.filter((issue) => {
			if (issue.kind === 'requirement_removed') {
				return changed.has(pluginDefinitionIndexKey(issue.consumer.definition))
			}
			if (
				issue.kind === 'provider_unavailable' ||
				issue.kind === 'provider_incompatible' ||
				issue.kind === 'fork_default_forbidden' ||
				issue.kind === 'provider_default_requires_abstract' ||
				issue.kind === 'explicit_binding_invalid'
			) {
				const providerKey = pluginDefinitionIndexKey(issue.provider.definition)
				const consumerKey =
					'consumer' in issue && issue.consumer
						? pluginDefinitionIndexKey(issue.consumer.definition)
						: undefined
				return changed.has(providerKey) || (consumerKey !== undefined && changed.has(consumerKey))
			}
			if (issue.kind === 'fork_not_allowed') {
				return changed.has(pluginDefinitionIndexKey(issue.node.definition))
			}
			if (issue.kind === 'missing_required_provider') {
				return changed.has(pluginDefinitionIndexKey(issue.consumer.definition))
			}
			if (issue.kind === 'consumer_unavailable') {
				const key = pluginDefinitionIndexKey(issue.consumer.definition)
				// Removing a consumer is valid. An override/provider target removal is represented
				// by one of the binding-specific issues above.
				return changed.has(key) && !removed.has(key)
			}
			return false
		}),
	)
}

type CandidateNode = Readonly<{
	address: PluginNodeAddress
	entry: PluginRouteCatalogEntry
}>

type ResolvedOverride = Readonly<{
	consumer: PluginNodeAddress
	requirement: PluginDefinitionAddress
	provider: PluginNodeAddress
}>

type RequiredProviderEdge = Readonly<{
	consumerKey: string
	consumer: PluginNodeAddress
	requirement: PluginDefinitionAddress
}>

function propagateBlockedDependencies(input: {
	catalog: PluginRouteCatalogSnapshot
	candidates: ReadonlyMap<string, CandidateNode>
	enabled: ReadonlyMap<string, PluginNodeAddress>
	blocked: Set<string>
	providerDefaults: ReadonlyMap<
		string,
		Readonly<{ token: PluginDefinitionAddress; provider: PluginNodeAddress }>
	>
	validOverrides: ReadonlyMap<string, ResolvedOverride>
	issues: PluginReconciliationIssue[]
	issueKeys: Set<string>
}): void {
	const dependentsByProvider = new Map<string, RequiredProviderEdge[]>()
	const blockedQueue = [...input.blocked]

	for (const [consumerKey, node] of input.candidates) {
		if (!input.enabled.has(consumerKey) || input.blocked.has(consumerKey)) continue
		for (const requirement of node.entry.candidate.declaration.requires) {
			const explicit = input.validOverrides.get(overrideKey(node.address, requirement))?.provider
			const selected =
				explicit ?? resolveImplicitProvider(requirement, input.catalog, input.providerDefaults)
			if (!selected || !input.enabled.has(pluginNodeIndexKey(selected))) {
				blockMissingProvider(input, consumerKey, node.address, requirement)
				blockedQueue.push(consumerKey)
				break
			}
			const providerKey = pluginNodeIndexKey(selected)
			const dependents = dependentsByProvider.get(providerKey) ?? []
			dependents.push({ consumerKey, consumer: node.address, requirement })
			dependentsByProvider.set(providerKey, dependents)
		}
	}

	for (let cursor = 0; cursor < blockedQueue.length; cursor++) {
		const providerKey = blockedQueue[cursor]!
		for (const edge of dependentsByProvider.get(providerKey) ?? []) {
			if (input.blocked.has(edge.consumerKey)) continue
			blockMissingProvider(input, edge.consumerKey, edge.consumer, edge.requirement)
			blockedQueue.push(edge.consumerKey)
		}
	}
}

function blockMissingProvider(
	input: {
		blocked: Set<string>
		issues: PluginReconciliationIssue[]
		issueKeys: Set<string>
	},
	consumerKey: string,
	consumer: PluginNodeAddress,
	requirement: PluginDefinitionAddress,
): void {
	input.blocked.add(consumerKey)
	addIssue(input.issues, input.issueKeys, {
		kind: 'missing_required_provider',
		consumer,
		requirement,
		message: `Missing required Plugin provider ${formatPluginDefinitionReference(requirement)} for ${formatPluginNodeReference(consumer)}`,
	})
}

function candidateNodes(
	catalog: PluginRouteCatalogSnapshot,
	state: RuntimeStateSnapshot,
	issues: PluginReconciliationIssue[],
	issueKeys: Set<string>,
	blocked: Set<string>,
): Map<string, CandidateNode> {
	const nodes = new Map<string, CandidateNode>()
	for (const entry of catalog.entries) {
		const address: PluginNodeAddress = { definition: entry.address, variant: 'default' }
		nodes.set(pluginNodeIndexKey(address), Object.freeze({ address, entry }))
	}
	for (const family of state.forks) {
		const entry = pluginCatalogEntry(catalog, family.definition)
		for (const forkId of family.forkIds) {
			const address: PluginNodeAddress = {
				definition: family.definition,
				variant: 'fork',
				forkId,
			}
			const key = pluginNodeIndexKey(address)
			if (!entry) continue
			if (!entry.candidate.declaration.forkable) {
				addIssue(issues, issueKeys, {
					kind: 'fork_not_allowed',
					node: address,
					message: `Plugin definition is not forkable: ${formatPluginNodeReference(address)}`,
				})
				blocked.add(key)
				continue
			}
			nodes.set(key, Object.freeze({ address, entry }))
		}
	}
	return nodes
}

function resolveProviderDefaults(input: {
	catalog: PluginRouteCatalogSnapshot
	state: RuntimeStateSnapshot
	enabled: ReadonlyMap<string, PluginNodeAddress>
	durableForks: ReadonlySet<string>
	issues: PluginReconciliationIssue[]
	issueKeys: Set<string>
}): {
	effective: Map<string, { token: PluginDefinitionAddress; provider: PluginNodeAddress }>
	inferred: Array<{ token: PluginDefinitionAddress; provider: PluginNodeAddress }>
} {
	const effective = new Map<
		string,
		{ token: PluginDefinitionAddress; provider: PluginNodeAddress }
	>()
	const inferred: Array<{ token: PluginDefinitionAddress; provider: PluginNodeAddress }> = []
	const explicit = new Set<string>()
	for (const binding of input.state.providerDefaults) {
		const key = pluginDefinitionIndexKey(binding.token)
		explicit.add(key)
		const issue = validateProvider({
			catalog: input.catalog,
			enabled: input.enabled,
			durableForks: input.durableForks,
			binding: 'provider-default',
			requirement: binding.token,
			provider: binding.provider,
		})
		if (issue) addIssue(input.issues, input.issueKeys, issue)
		else effective.set(key, { token: binding.token, provider: binding.provider })
	}

	const candidates = new Map<
		string,
		Array<{ token: PluginDefinitionAddress; provider: PluginNodeAddress }>
	>()
	for (const entry of input.catalog.entries) {
		const token = entry.candidate.declaration.provides
		if (!token) continue
		const provider: PluginNodeAddress = { definition: entry.address, variant: 'default' }
		if (!input.enabled.has(pluginNodeIndexKey(provider))) continue
		const key = pluginDefinitionIndexKey(token)
		const list = candidates.get(key) ?? []
		list.push({ token, provider })
		candidates.set(key, list)
	}
	for (const [key, list] of candidates) {
		if (explicit.has(key)) continue
		list.sort((left, right) =>
			pluginNodeIndexKey(left.provider).localeCompare(pluginNodeIndexKey(right.provider)),
		)
		const selected = list[0]
		if (!selected) continue
		effective.set(key, selected)
		inferred.push(selected)
	}
	return { effective, inferred }
}

function validateProvider(input: {
	catalog: PluginRouteCatalogSnapshot
	enabled: ReadonlyMap<string, PluginNodeAddress>
	durableForks: ReadonlySet<string>
	binding: 'provider-default' | 'dependency-override'
	consumer?: PluginNodeAddress
	requirement: PluginDefinitionAddress
	provider: PluginNodeAddress
}): PluginReconciliationIssue | undefined {
	if (input.binding === 'provider-default' && input.provider.variant === 'fork') {
		return {
			kind: 'fork_default_forbidden',
			requirement: input.requirement,
			provider: input.provider,
			message: 'A fork cannot be selected as a global provider default',
		}
	}
	const entry = pluginCatalogEntry(input.catalog, input.provider.definition)
	if (
		!entry ||
		(input.provider.variant === 'fork' &&
			!input.durableForks.has(pluginNodeIndexKey(input.provider)))
	) {
		return bindingIssue(
			'provider_unavailable',
			input,
			'Provider is not available in the route catalog',
		)
	}
	if (input.provider.variant === 'fork' && !entry.candidate.declaration.forkable) {
		return bindingIssue('explicit_binding_invalid', input, 'Explicit provider fork is not allowed')
	}
	if (
		input.binding === 'provider-default' &&
		(!entry.candidate.declaration.provides ||
			!pluginDefinitionAddressEqual(entry.candidate.declaration.provides, input.requirement))
	) {
		return {
			kind: 'provider_default_requires_abstract',
			requirement: input.requirement,
			provider: input.provider,
			message: 'Global provider default must publish the requested abstract token',
		}
	}
	if (!providerCompatible(entry, input.requirement)) {
		return bindingIssue(
			'provider_incompatible',
			input,
			'Provider does not implement the required Plugin definition',
		)
	}
	if (!input.enabled.has(pluginNodeIndexKey(input.provider))) {
		return bindingIssue('provider_disabled', input, 'Explicit provider is disabled')
	}
	return undefined
}

function bindingIssue(
	kind:
		| 'provider_unavailable'
		| 'provider_disabled'
		| 'provider_incompatible'
		| 'explicit_binding_invalid',
	input: {
		binding: 'provider-default' | 'dependency-override'
		consumer?: PluginNodeAddress
		requirement: PluginDefinitionAddress
		provider: PluginNodeAddress
	},
	message: string,
): PluginReconciliationIssue {
	return {
		kind,
		binding: input.binding,
		...(input.consumer ? { consumer: input.consumer } : {}),
		requirement: input.requirement,
		provider: input.provider,
		message,
	} as PluginReconciliationIssue
}

function providerCompatible(
	entry: PluginRouteCatalogEntry,
	requirement: PluginDefinitionAddress,
): boolean {
	return (
		pluginDefinitionAddressEqual(entry.address, requirement) ||
		(!!entry.candidate.declaration.provides &&
			pluginDefinitionAddressEqual(entry.candidate.declaration.provides, requirement))
	)
}

function hasRequirement(
	entry: PluginRouteCatalogEntry,
	requirement: PluginDefinitionAddress,
): boolean {
	return entry.candidate.declaration.requires.some((address) =>
		pluginDefinitionAddressEqual(address, requirement),
	)
}

function resolveImplicitProvider(
	requirement: PluginDefinitionAddress,
	catalog: PluginRouteCatalogSnapshot,
	providerDefaults: ReadonlyMap<
		string,
		Readonly<{ token: PluginDefinitionAddress; provider: PluginNodeAddress }>
	>,
): PluginNodeAddress | undefined {
	const concrete = pluginCatalogEntry(catalog, requirement)
	if (concrete) return { definition: concrete.address, variant: 'default' }
	return providerDefaults.get(pluginDefinitionIndexKey(requirement))?.provider
}

function durableForkIndex(state: RuntimeStateSnapshot): Set<string> {
	const out = new Set<string>()
	for (const family of state.forks) {
		for (const forkId of family.forkIds) {
			out.add(pluginNodeIndexKey({ definition: family.definition, variant: 'fork', forkId }))
		}
	}
	return out
}

function diffAppliedGraph(
	current: AppliedPluginGraphSnapshot,
	next: AppliedPluginGraphSnapshot,
): CorePluginOperation[] {
	const operations: CorePluginOperation[] = []
	const currentByDefinition = nodesByDefinition(current.nodes)
	const nextByDefinition = nodesByDefinition(next.nodes)
	for (const [definitionKey, node] of nextByDefinition) {
		const previous = currentByDefinition.get(definitionKey)
		if (!previous || previous.candidate === node.candidate) continue
		operations.push({
			type: 'replace-definition',
			address: node.address.definition,
			candidate: node.candidate,
			cascadeDependents: true,
		})
	}
	for (const [key, node] of next.nodes) {
		if (current.nodes.has(key)) continue
		operations.push({ type: 'materialize-node', address: node.address, candidate: node.candidate })
	}

	for (const [key, binding] of current.dependencyOverrides) {
		const desired = next.dependencyOverrides.get(key)
		if (desired && pluginNodeAddressEqual(desired.provider, binding.provider)) continue
		operations.push({
			type: 'set-dependency-override',
			consumer: binding.consumer,
			requirement: binding.requirement,
			provider: null,
		})
	}
	for (const [key, binding] of next.dependencyOverrides) {
		const previous = current.dependencyOverrides.get(key)
		if (previous && pluginNodeAddressEqual(previous.provider, binding.provider)) continue
		operations.push({ type: 'set-dependency-override', ...binding })
	}

	for (const [key, binding] of current.providerDefaults) {
		const desired = next.providerDefaults.get(key)
		if (desired && pluginNodeAddressEqual(desired.provider, binding.provider)) continue
		operations.push({ type: 'set-provider-default', token: binding.token, provider: null })
	}
	for (const [key, binding] of next.providerDefaults) {
		const previous = current.providerDefaults.get(key)
		if (previous && pluginNodeAddressEqual(previous.provider, binding.provider)) continue
		operations.push({ type: 'set-provider-default', ...binding })
	}

	for (const [key, node] of current.nodes) {
		if (next.nodes.has(key)) continue
		operations.push({
			type: 'dematerialize-node',
			address: node.address,
			cascadeDependents: true,
		})
	}
	return operations
}

function nodesByDefinition(nodes: ReadonlyMap<string, AppliedNode>): Map<string, AppliedNode> {
	const out = new Map<string, AppliedNode>()
	for (const node of nodes.values()) {
		const key = pluginDefinitionIndexKey(node.address.definition)
		if (!out.has(key)) out.set(key, node)
	}
	return out
}

function overrideKey(consumer: PluginNodeAddress, requirement: PluginDefinitionAddress): string {
	return `${pluginNodeIndexKey(consumer)}:${pluginDefinitionIndexKey(requirement)}`
}

function addIssue(
	issues: PluginReconciliationIssue[],
	keys: Set<string>,
	issue: PluginReconciliationIssue,
): void {
	const key = pluginReconciliationIssueKey(issue)
	if (keys.has(key)) return
	keys.add(key)
	issues.push(Object.freeze(issue))
}

/** Stable semantic identity for one reconciliation issue across status projections. */
export function pluginReconciliationIssueKey(issue: PluginReconciliationIssue): string {
	const consumer = 'consumer' in issue ? pluginNodeIndexKey(issue.consumer) : ''
	const requirement = 'requirement' in issue ? pluginDefinitionIndexKey(issue.requirement) : ''
	const provider = 'provider' in issue ? pluginNodeIndexKey(issue.provider) : ''
	const node = 'node' in issue ? pluginNodeIndexKey(issue.node) : ''
	return `${issue.kind}:${consumer}:${requirement}:${provider}:${node}`
}

function sortIssues(issues: PluginReconciliationIssue[]): PluginReconciliationIssue[] {
	return issues.sort((left, right) =>
		pluginReconciliationIssueKey(left).localeCompare(pluginReconciliationIssueKey(right)),
	)
}
