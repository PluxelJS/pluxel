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
import type { HostStateSnapshot } from './policy'
import type { PluginCatalogSnapshot } from './catalog'

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
			kind: 'provider_unavailable' | 'provider_incompatible'
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

export type PluginSessionIntent = 'inherit' | 'run' | 'stop'
export type PluginActivationReason = 'auto-start' | 'session' | 'dependency'

export type HostPluginSessionEntry = Readonly<{
	address: PluginNodeAddress
	intent: Exclude<PluginSessionIntent, 'inherit'>
}>

export type HostPluginDesiredControl = Readonly<{
	address: PluginNodeAddress
	activationReason: PluginActivationReason
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
	coreOperations: readonly CorePluginOperation[]
	blocked: readonly PluginReconciliationIssue[]
	desiredControl: ReadonlyMap<string, HostPluginDesiredControl>
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
	catalog: PluginCatalogSnapshot
	runtimeState: HostStateSnapshot
	runtimeStateRevision: number
	sessionIntents?: ReadonlyMap<string, HostPluginSessionEntry>
	applied?: AppliedPluginGraphSnapshot
}): ReconciliationPlan {
	const applied = input.applied ?? emptyAppliedPluginGraphSnapshot()
	const selection = selectPluginGraph({
		declarations: input.catalog.declarations,
		runtimeState: input.runtimeState,
		sessionIntents: input.sessionIntents,
	})
	const nodes = new Map<string, AppliedNode>()
	for (const [key, { address }] of selection.nodes) {
		const candidate = input.catalog.byDefinition.get(
			pluginDefinitionIndexKey(address.definition),
		)!.candidate
		nodes.set(key, Object.freeze({ address, candidate }))
	}
	const nextApplied: AppliedPluginGraphSnapshot = Object.freeze({
		nodes,
		providerDefaults: selection.providerDefaults,
		dependencyOverrides: selection.dependencyOverrides,
	})
	return Object.freeze({
		catalogRevision: input.catalog.revision,
		runtimeStateRevision: input.runtimeStateRevision,
		coreOperations: Object.freeze(diffAppliedGraph(applied, nextApplied)),
		blocked: selection.blocked,
		desiredControl: selection.desiredControl,
		applied: nextApplied,
	})
}

export type PolicyDeclaration = Pick<
	ConcretePluginDefinitionCandidate['declaration'],
	'address' | 'requires' | 'optional' | 'provides'
> &
	Readonly<{ forkable?: boolean }>
type Declarations = ReadonlyMap<string, PolicyDeclaration>
/** Evaluate desired policy on declarations before attaching any executable implementation. */
export function selectPluginGraph(input: {
	declarations: Declarations
	runtimeState: HostStateSnapshot
	sessionIntents?: ReadonlyMap<string, HostPluginSessionEntry>
}) {
	const issues: PluginReconciliationIssue[] = []
	const issueKeys = new Set<string>()
	const blocked = new Set<string>()
	const sessionIntents = input.sessionIntents ?? new Map<string, HostPluginSessionEntry>()
	const explicitStops = new Set(
		[...sessionIntents].filter(([, entry]) => entry.intent === 'stop').map(([key]) => key),
	)
	const desired = new Map<string, PluginNodeAddress>()
	const activationReasons = new Map<string, PluginActivationReason>()
	for (const address of input.runtimeState.autoStart) {
		const key = pluginNodeIndexKey(address)
		if (explicitStops.has(key)) continue
		desired.set(key, address)
		activationReasons.set(key, 'auto-start')
	}
	for (const [key, entry] of sessionIntents) {
		if (entry.intent !== 'run') continue
		desired.set(key, entry.address)
		activationReasons.set(key, 'session')
	}
	const durableForks = durableForkIndex(input.runtimeState)
	const candidates = candidateNodes(
		input.declarations,
		input.runtimeState,
		issues,
		issueKeys,
		blocked,
	)

	for (const [key, address] of desired) {
		if (candidates.has(key)) continue
		addIssue(issues, issueKeys, {
			kind: 'consumer_unavailable',
			consumer: address,
			message: `Plugin node is desired but unavailable: ${formatPluginNodeReference(address)}`,
		})
		blocked.add(key)
	}

	const providerDefaults = resolveProviderDefaults({
		catalog: input.declarations,
		state: input.runtimeState,
		durableForks,
		issues,
		issueKeys,
	})

	const validOverrides = new Map<string, ResolvedOverride>()
	const unavailableOverrides = new Map<string, PluginNodeAddress>()
	for (const override of input.runtimeState.dependencyOverrides) {
		const consumerKey = pluginNodeIndexKey(override.consumerAddress)
		const consumer = candidates.get(consumerKey)
		const consumerDesired = desired.has(consumerKey)
		if (!consumer) {
			addIssue(issues, issueKeys, {
				kind: 'consumer_unavailable',
				consumer: override.consumerAddress,
				message: `Dependency override consumer is unavailable: ${formatPluginNodeReference(override.consumerAddress)}`,
			})
			if (consumerDesired) blocked.add(consumerKey)
			continue
		}
		if (!hasRequirement(consumer.declaration, override.requirementAddress)) {
			addIssue(issues, issueKeys, {
				kind: 'requirement_removed',
				binding: 'dependency-override',
				consumer: override.consumerAddress,
				requirement: override.requirementAddress,
				provider: override.providerAddress,
				message: `Dependency requirement no longer exists: ${formatPluginDefinitionReference(override.requirementAddress)}`,
			})
			if (consumerDesired) blocked.add(consumerKey)
			continue
		}
		const providerIssue = validateProvider({
			catalog: input.declarations,
			durableForks,
			binding: 'dependency-override',
			consumer: override.consumerAddress,
			requirement: override.requirementAddress,
			provider: override.providerAddress,
		})
		const resolvedOverride = {
			consumer: override.consumerAddress,
			requirement: override.requirementAddress,
			provider: override.providerAddress,
		}
		if (providerIssue) {
			addIssue(issues, issueKeys, providerIssue)
			if (consumerDesired) blocked.add(consumerKey)
			if (providerIssue.kind === 'provider_unavailable') {
				unavailableOverrides.set(consumerKey, override.providerAddress)
			}
			continue
		}
		validOverrides.set(
			overrideKey(override.consumerAddress, override.requirementAddress),
			resolvedOverride,
		)
	}

	expandRequiredProviders({
		catalog: input.declarations,
		candidates,
		desired,
		activationReasons,
		explicitStops,
		blocked,
		providerDefaults: providerDefaults.selected,
		invalidProviderDefaults: providerDefaults.invalid,
		validOverrides,
		unavailableOverrides,
		issues,
		issueKeys,
	})

	const desiredNodes = new Map<string, CandidateNode>()
	for (const [key, node] of candidates) {
		if (!desired.has(key) || blocked.has(key)) continue
		desiredNodes.set(key, node)
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

	const desiredControl = new Map<string, HostPluginDesiredControl>()
	for (const [key, address] of desired) {
		const activationReason = activationReasons.get(key)
		if (!activationReason) continue
		desiredControl.set(key, Object.freeze({ address, activationReason }))
	}
	return Object.freeze({
		nodes: desiredNodes,
		providerDefaults: desiredProviderDefaults,
		dependencyOverrides: desiredOverrides,
		blocked: Object.freeze(sortIssues(issues)),
		desiredControl,
	})
}

/**
 * Selects desired-policy issues that make a live catalog transition unsafe.
 * Cold boot keeps the same issues as blocked projection; a live process keeps its
 * last-known-good catalog instead of invalidating explicit state or half-replacing a definition.
 */
export function catalogTransitionRejections(input: {
	previous: PluginCatalogSnapshot
	next: PluginCatalogSnapshot
	plan: ReconciliationPlan
}): readonly PluginReconciliationIssue[] {
	const changed = new Set<string>()
	for (const entry of input.next.entries) {
		const previous = input.previous.byDefinition.get(entry.indexKey)
		if (!previous || previous.candidate !== entry.candidate) changed.add(entry.indexKey)
	}
	return livePolicyRejections(changed, input.plan.blocked)
}

/** Policy failures that retain the committed catalog when the given definitions change live. */
export function livePolicyRejections(
	changed: ReadonlySet<string>,
	issues: readonly PluginReconciliationIssue[],
): readonly PluginReconciliationIssue[] {
	return Object.freeze(
		issues.filter((issue) => {
			switch (issue.kind) {
				case 'consumer_unavailable':
				case 'missing_required_provider':
				case 'requirement_removed':
					return changed.has(pluginDefinitionIndexKey(issue.consumer.definition))
				case 'fork_not_allowed':
					return changed.has(pluginDefinitionIndexKey(issue.node.definition))
				default:
					return (
						changed.has(pluginDefinitionIndexKey(issue.provider.definition)) ||
						('consumer' in issue &&
							issue.consumer !== undefined &&
							changed.has(pluginDefinitionIndexKey(issue.consumer.definition)))
					)
			}
		}),
	)
}

type CandidateNode = Readonly<{
	address: PluginNodeAddress
	declaration: PolicyDeclaration
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

function expandRequiredProviders(input: {
	catalog: Declarations
	candidates: ReadonlyMap<string, CandidateNode>
	desired: Map<string, PluginNodeAddress>
	activationReasons: Map<string, PluginActivationReason>
	explicitStops: ReadonlySet<string>
	blocked: Set<string>
	providerDefaults: ReadonlyMap<
		string,
		Readonly<{ token: PluginDefinitionAddress; provider: PluginNodeAddress }>
	>
	invalidProviderDefaults: ReadonlyMap<string, PluginReconciliationIssue>
	validOverrides: ReadonlyMap<string, ResolvedOverride>
	unavailableOverrides: ReadonlyMap<string, PluginNodeAddress>
	issues: PluginReconciliationIssue[]
	issueKeys: Set<string>
}): void {
	const dependentsByProvider = new Map<string, RequiredProviderEdge[]>()
	const desiredQueue = [...input.desired.keys()]

	for (let cursor = 0; cursor < desiredQueue.length; cursor++) {
		const consumerKey = desiredQueue[cursor]!
		if (input.blocked.has(consumerKey)) {
			const unavailableProvider = input.unavailableOverrides.get(consumerKey)
			if (unavailableProvider) {
				addDependencyDesired(input, desiredQueue, unavailableProvider)
			}
			continue
		}
		const node = input.candidates.get(consumerKey)
		if (!node) continue
		for (const requirement of node.declaration.requires) {
			const explicit = input.validOverrides.get(overrideKey(node.address, requirement))?.provider
			const requirementKey = pluginDefinitionIndexKey(requirement)
			if (!explicit && !input.catalog.get(requirementKey)) {
				const invalidDefault = input.invalidProviderDefaults.get(requirementKey)
				if (invalidDefault) {
					if (invalidDefault.kind === 'provider_unavailable') {
						addDependencyDesired(input, desiredQueue, invalidDefault.provider)
					}
					blockMissingProvider(input, consumerKey, node.address, requirement)
					break
				}
			}
			const selected =
				explicit ?? resolveImplicitProvider(requirement, input.catalog, input.providerDefaults)
			const providerKey = selected ? pluginNodeIndexKey(selected) : undefined
			if (!selected || !providerKey || input.explicitStops.has(providerKey)) {
				blockMissingProvider(input, consumerKey, node.address, requirement)
				break
			}
			addDependencyDesired(input, desiredQueue, selected)
			if (!input.candidates.has(providerKey)) {
				blockMissingProvider(input, consumerKey, node.address, requirement)
				break
			}
			const dependents = dependentsByProvider.get(providerKey) ?? []
			dependents.push({ consumerKey, consumer: node.address, requirement })
			dependentsByProvider.set(providerKey, dependents)
		}
	}

	const blockedQueue = [...input.blocked]
	for (let cursor = 0; cursor < blockedQueue.length; cursor++) {
		const providerKey = blockedQueue[cursor]!
		for (const edge of dependentsByProvider.get(providerKey) ?? []) {
			if (input.blocked.has(edge.consumerKey)) continue
			blockMissingProvider(input, edge.consumerKey, edge.consumer, edge.requirement)
			blockedQueue.push(edge.consumerKey)
		}
	}
}

function addDependencyDesired(
	input: {
		desired: Map<string, PluginNodeAddress>
		activationReasons: Map<string, PluginActivationReason>
	},
	desiredQueue: string[],
	provider: PluginNodeAddress,
): void {
	const providerKey = pluginNodeIndexKey(provider)
	if (input.desired.has(providerKey)) return
	input.desired.set(providerKey, provider)
	input.activationReasons.set(providerKey, 'dependency')
	desiredQueue.push(providerKey)
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
	catalog: Declarations,
	state: HostStateSnapshot,
	issues: PluginReconciliationIssue[],
	issueKeys: Set<string>,
	blocked: Set<string>,
): Map<string, CandidateNode> {
	const nodes = new Map<string, CandidateNode>()
	for (const declaration of catalog.values()) {
		const address: PluginNodeAddress = { definition: declaration.address, variant: 'default' }
		nodes.set(pluginNodeIndexKey(address), Object.freeze({ address, declaration }))
	}
	for (const address of state.forks) {
		const declaration = catalog.get(pluginDefinitionIndexKey(address.definition))
		const key = pluginNodeIndexKey(address)
		if (!declaration) continue
		if (!declaration.forkable) {
			addIssue(issues, issueKeys, {
				kind: 'fork_not_allowed',
				node: address,
				message: `Plugin definition is not forkable: ${formatPluginNodeReference(address)}`,
			})
			blocked.add(key)
			continue
		}
		nodes.set(key, Object.freeze({ address, declaration }))
	}
	return nodes
}

function resolveProviderDefaults(input: {
	catalog: Declarations
	state: HostStateSnapshot
	durableForks: ReadonlySet<string>
	issues: PluginReconciliationIssue[]
	issueKeys: Set<string>
}): {
	selected: Map<string, { token: PluginDefinitionAddress; provider: PluginNodeAddress }>
	effective: Map<string, { token: PluginDefinitionAddress; provider: PluginNodeAddress }>
	invalid: Map<string, PluginReconciliationIssue>
} {
	const selectedBindings = new Map<
		string,
		{ token: PluginDefinitionAddress; provider: PluginNodeAddress }
	>()
	const effective = new Map<
		string,
		{ token: PluginDefinitionAddress; provider: PluginNodeAddress }
	>()
	const invalid = new Map<string, PluginReconciliationIssue>()
	const explicit = new Set<string>()
	for (const binding of input.state.providerDefaults) {
		const key = pluginDefinitionIndexKey(binding.token)
		explicit.add(key)
		selectedBindings.set(key, { token: binding.token, provider: binding.provider })
		const issue = validateProvider({
			catalog: input.catalog,
			durableForks: input.durableForks,
			binding: 'provider-default',
			requirement: binding.token,
			provider: binding.provider,
		})
		if (issue) {
			addIssue(input.issues, input.issueKeys, issue)
			invalid.set(key, issue)
		} else effective.set(key, { token: binding.token, provider: binding.provider })
	}

	const candidates = new Map<
		string,
		Array<{ token: PluginDefinitionAddress; provider: PluginNodeAddress }>
	>()
	for (const declaration of input.catalog.values()) {
		const token = declaration.provides
		if (!token) continue
		const provider: PluginNodeAddress = { definition: declaration.address, variant: 'default' }
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
		selectedBindings.set(key, selected)
		effective.set(key, selected)
	}
	return { selected: selectedBindings, effective, invalid }
}

function validateProvider(input: {
	catalog: Declarations
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
	const declaration = input.catalog.get(pluginDefinitionIndexKey(input.provider.definition))
	if (
		!declaration ||
		(input.provider.variant === 'fork' &&
			!input.durableForks.has(pluginNodeIndexKey(input.provider)))
	) {
		return bindingIssue(
			'provider_unavailable',
			input,
			'Provider is not available in the route catalog',
		)
	}
	if (input.provider.variant === 'fork' && !declaration.forkable) {
		return bindingIssue('explicit_binding_invalid', input, 'Explicit provider fork is not allowed')
	}
	if (
		input.binding === 'provider-default' &&
		(!declaration.provides ||
			!pluginDefinitionAddressEqual(declaration.provides, input.requirement))
	) {
		return {
			kind: 'provider_default_requires_abstract',
			requirement: input.requirement,
			provider: input.provider,
			message: 'Global provider default must publish the requested abstract token',
		}
	}
	if (!providerCompatible(declaration, input.requirement)) {
		return bindingIssue(
			'provider_incompatible',
			input,
			'Provider does not implement the required Plugin definition',
		)
	}
	return undefined
}

function bindingIssue(
	kind: 'provider_unavailable' | 'provider_incompatible' | 'explicit_binding_invalid',
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
	declaration: PolicyDeclaration,
	requirement: PluginDefinitionAddress,
): boolean {
	return (
		pluginDefinitionAddressEqual(declaration.address, requirement) ||
		(!!declaration.provides && pluginDefinitionAddressEqual(declaration.provides, requirement))
	)
}

function hasRequirement(
	declaration: PolicyDeclaration,
	requirement: PluginDefinitionAddress,
): boolean {
	return declaration.requires.some((address) => pluginDefinitionAddressEqual(address, requirement))
}

function resolveImplicitProvider(
	requirement: PluginDefinitionAddress,
	catalog: Declarations,
	providerDefaults: ReadonlyMap<
		string,
		Readonly<{ token: PluginDefinitionAddress; provider: PluginNodeAddress }>
	>,
): PluginNodeAddress | undefined {
	const concrete = catalog.get(pluginDefinitionIndexKey(requirement))
	if (concrete) return { definition: concrete.address, variant: 'default' }
	return providerDefaults.get(pluginDefinitionIndexKey(requirement))?.provider
}

/** Required bindings for materializable nodes, using the same override and implicit selection as reconciliation. */
export function selectedRequiredBindings(
	catalog: Declarations,
	graph: Pick<AppliedPluginGraphSnapshot, 'dependencyOverrides' | 'providerDefaults'> & {
		nodes: ReadonlyMap<string, { address: PluginNodeAddress }>
	},
) {
	const bindings = new Map<string, ResolvedOverride>()
	for (const { address: consumer } of graph.nodes.values()) {
		const declaration = catalog.get(pluginDefinitionIndexKey(consumer.definition))!
		for (const requirement of declaration.requires) {
			const key = overrideKey(consumer, requirement)
			const provider =
				graph.dependencyOverrides.get(key)?.provider ??
				resolveImplicitProvider(requirement, catalog, graph.providerDefaults)
			if (provider) bindings.set(key, { consumer, requirement, provider })
		}
	}
	return bindings
}

function durableForkIndex(state: HostStateSnapshot): Set<string> {
	return new Set(state.forks.map(pluginNodeIndexKey))
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
	const consumer =
		'consumer' in issue && issue.consumer !== undefined ? pluginNodeIndexKey(issue.consumer) : ''
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
