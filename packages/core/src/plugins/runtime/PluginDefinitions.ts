import type { Context, PluginContext } from '../../context/Context'
import { closeConsumerInvocations, closeOwnerInvocations } from '../../internal/owner-invocations'
import { createErr, createOk } from 'option-t/plain_result'
import {
	DraftGraph,
	factoryProvider,
	GraphBuildError,
	type GraphBuildError as GraphBuildErrorType,
	type GraphDelta,
	type GraphSnapshot,
	Runtime,
} from '../../internal/di'
import {
	BasePlugin,
	constructPluginGeneration,
	type PluginRequirementResolver,
} from '../composition/BasePlugin'
import { createCallerGenerationView } from '../composition/caller-view'
import { pinContextValue } from '../composition/context-projection'
import type { PluginConstructor } from '../types'
import type { ConcretePluginDefinitionCandidate, PluginConfigDefinition } from './definition'
import {
	isPluginNodeSlot,
	parsePluginDefinitionAddress,
	parsePluginNodeAddress,
	pluginDefinitionAddressEqual,
	pluginDefinitionIndexKey,
	type PluginDefinitionAddress,
	type PluginDefinitionSlot,
	type PluginNodeAddress,
	type PluginNodeSlot,
	PluginSlotRegistry,
} from './identity'
import type { PluginPartDefinitionTree } from './part-definition'

export type ConcretePluginDefinitionRecord = Readonly<{
	address: PluginDefinitionAddress
	slot: PluginDefinitionSlot
	implementation: PluginConstructor
	revision: number
	displayName: string
	startTimeoutMs?: number
	constructorRequires: readonly PluginDefinitionSlot[]
	requires: readonly PluginDefinitionSlot[]
	optional: readonly PluginDefinitionSlot[]
	dependencyRequests: readonly Readonly<{
		definition: PluginDefinitionSlot
		mode: 'required' | 'optional'
		partPath: readonly string[]
	}>[]
	provides?: PluginDefinitionSlot
	config?: PluginConfigDefinition
	parts: PluginPartDefinitionTree
	forkable: boolean
}>

export type PluginNodeRecord = Readonly<{
	address: PluginNodeAddress
	slot: PluginNodeSlot
	definition: ConcretePluginDefinitionRecord
}>

/** Immutable generation-scoped Context projection. */
export type PluginNodeInfo = Readonly<{
	nodeAddress: PluginNodeAddress
	nodeSlot: PluginNodeSlot
	definitionAddress: PluginDefinitionAddress
	definitionRevision: number
	displayName: string
}>

/** @internal Core-only generation facts; never attached to the public Context shape. */
export type PluginGenerationInfo = Readonly<{
	definitionSlot: PluginDefinitionSlot
	implementation: PluginConstructor
	startTimeoutMs?: number
	config?: PluginConfigDefinition
}>

const generationInfoByContext = new WeakMap<Context, PluginGenerationInfo>()

/** @internal Read Core-only facts for one generation Context. */
export function requirePluginGenerationInfo(ctx: Context): PluginGenerationInfo {
	const info = generationInfoByContext.get(ctx)
	if (!info) throw new Error('[pluxel/core] Context is not a Plugin generation')
	return info
}

export type PluginGraph = GraphSnapshot<PluginNodeRecord>
export type PluginRuntime = Runtime<PluginNodeRecord>
export type CreatePluginContext = () => Context

type DependencyBinding = Readonly<{
	consumer: PluginNodeSlot
	requirement: PluginDefinitionSlot
	provider: PluginNodeSlot
}>

type DefinitionFamilyDelta = {
	readonly added: Set<PluginNodeSlot>
	readonly removed: Set<PluginNodeSlot>
}

type PluginGraphDelta = Omit<GraphDelta, 'added' | 'removed' | 'replaced' | 'affected'> & {
	readonly added: readonly PluginNodeSlot[]
	readonly removed: readonly PluginNodeSlot[]
	readonly replaced: readonly { from: PluginNodeSlot; to: PluginNodeSlot }[]
	readonly affected: readonly PluginNodeSlot[]
}

type BuildRet = {
	graph: PluginGraph
	runtime: PluginRuntime
	delta: PluginGraphDelta
	confirm: () => void
}

export class PluginGenerationConstructionError extends Error {
	readonly cleanup: Promise<void>

	constructor(cause: unknown, cleanup: Promise<void>) {
		const detail = cause instanceof Error ? cause.message : String(cause)
		super(`Plugin generation construction failed: ${detail}`, { cause })
		this.cleanup = cleanup
	}
}

export class PluginDefinitions {
	private readonly draft = new DraftGraph<PluginNodeRecord>()
	private committedRuntime?: PluginRuntime
	readonly slots = new PluginSlotRegistry()

	private readonly definitions = new Map<PluginDefinitionSlot, ConcretePluginDefinitionRecord>()
	private readonly nodes = new Map<PluginNodeSlot, PluginNodeRecord>()
	private readonly nodesByDefinition = new Map<PluginDefinitionSlot, Set<PluginNodeSlot>>()
	private readonly providerDefaults = new Map<PluginDefinitionSlot, PluginNodeSlot>()
	private readonly bindingsByConsumer = new Map<
		PluginNodeSlot,
		ReadonlyMap<PluginDefinitionSlot, DependencyBinding>
	>()
	private readonly inboundBindings = new Map<PluginDefinitionSlot, ReadonlySet<DependencyBinding>>()
	private readonly providersByAbstract = new Map<
		PluginDefinitionSlot,
		ReadonlySet<PluginDefinitionSlot>
	>()

	private readonly pendingDefinitions = new Map<
		PluginDefinitionSlot,
		ConcretePluginDefinitionRecord | null
	>()
	private readonly pendingNodes = new Map<PluginNodeSlot, PluginNodeRecord | null>()
	private readonly pendingNodeFamilyDeltas = new Map<PluginDefinitionSlot, DefinitionFamilyDelta>()
	private readonly pendingProviderDefaults = new Map<PluginDefinitionSlot, PluginNodeSlot | null>()
	private readonly pendingBindingsByConsumer = new Map<
		PluginNodeSlot,
		ReadonlyMap<PluginDefinitionSlot, DependencyBinding> | null
	>()
	private readonly pendingInboundBindings = new Map<
		PluginDefinitionSlot,
		ReadonlySet<DependencyBinding> | null
	>()
	private readonly pendingProvidersByAbstract = new Map<
		PluginDefinitionSlot,
		ReadonlySet<PluginDefinitionSlot> | null
	>()

	private readonly candidateByRecord = new WeakMap<
		ConcretePluginDefinitionRecord,
		ConcretePluginDefinitionCandidate
	>()
	private readonly nextRevision = new WeakMap<PluginDefinitionSlot, number>()
	private readonly dirtyDefinitions = new Set<PluginDefinitionSlot>()
	private readonly dirtyConsumers = new Set<PluginNodeSlot>()
	private readonly dirtyProviderTokens = new Set<PluginDefinitionSlot>()

	constructor(private readonly createPluginContext: CreatePluginContext) {}

	get lastGraph(): PluginGraph {
		return this.draft.graph
	}

	hasPendingChanges(): boolean {
		return this.draft.hasPendingChanges()
	}

	get runtime(): PluginRuntime {
		const graph = this.lastGraph
		if (this.committedRuntime?.graph === graph) return this.committedRuntime
		return (this.committedRuntime = new Runtime(graph, this.draft.instances))
	}

	internDefinition(address: PluginDefinitionAddress): PluginDefinitionSlot {
		return this.slots.internDefinition(address)
	}

	internNode(address: PluginNodeAddress): PluginNodeSlot {
		return this.slots.internNode(address)
	}

	lookupDefinition(address: PluginDefinitionAddress): PluginDefinitionSlot | undefined {
		return this.slots.lookupDefinition(address)
	}

	resolvePlanningNode(address: PluginNodeAddress): PluginNodeSlot | undefined {
		const slot = this.slots.lookupNode(address)
		if (!slot) return undefined
		return this.nodeRecord(slot) ? slot : undefined
	}

	resolveCommittedNode(address: PluginNodeAddress): PluginNodeSlot | undefined {
		const slot = this.slots.lookupNode(address)
		if (!slot) return undefined
		return this.nodes.has(slot) ? slot : undefined
	}

	planningNodeRecord(slot: PluginNodeSlot): PluginNodeRecord | undefined {
		this.slots.nodeAddress(slot)
		return this.nodeRecord(slot)
	}

	committedNodeRecord(slot: PluginNodeSlot): PluginNodeRecord | undefined {
		this.slots.nodeAddress(slot)
		return this.nodes.get(slot)
	}

	planningDefinitionRecord(
		address: PluginDefinitionAddress,
	): ConcretePluginDefinitionRecord | undefined {
		const definition = this.slots.lookupDefinition(address)
		return definition ? this.definitionRecord(definition) : undefined
	}

	collectPlanningCascadeTargets(nodes: Iterable<PluginNodeSlot>): Set<PluginNodeSlot> {
		return this.draft.collectCascadeTargetsFrom(nodes) as Set<PluginNodeSlot>
	}

	materializedNodes(address: PluginDefinitionAddress): readonly PluginNodeSlot[] {
		const definition = this.slots.lookupDefinition(address)
		if (!definition) return []
		return [...this.definitionNodes(definition)]
	}

	materializeNode(
		inputAddress: PluginNodeAddress,
		candidate: ConcretePluginDefinitionCandidate,
	): PluginNodeSlot {
		const parsedAddress = parsePluginNodeAddress(inputAddress)
		this.assertCandidateAddress(candidate, parsedAddress.definition)
		const node = this.slots.internNode(parsedAddress)
		const definition = node.definition
		const address = this.slots.nodeAddress(node)
		let record = this.definitionRecord(definition)
		if (record) {
			if (this.candidateByRecord.get(record) !== candidate) {
				throw new Error(
					'[pluxel/core] A materialized definition can only change through replaceDefinition()',
				)
			}
		} else {
			record = this.createDefinitionRecord(definition, candidate)
			this.setDefinitionRecord(definition, record)
		}
		if (address.variant === 'fork' && !record.forkable) {
			throw new TypeError('[pluxel/core] Plugin definition does not allow fork nodes')
		}
		const current = this.nodeRecord(node)
		if (current) {
			if (current.definition !== record) {
				throw new Error('[pluxel/core] Conflicting Plugin node materialization')
			}
			return node
		}

		const nodeRecord = Object.freeze({ address, slot: node, definition: record })
		this.setNodeRecord(node, nodeRecord)
		this.addDefinitionNode(definition, node)
		this.dirtyDefinitions.add(definition)
		this.dirtyConsumers.add(node)
		this.draft.put(this.createProviderDeclaration(nodeRecord))
		return node
	}

	dematerializeNode(inputAddress: PluginNodeAddress): PluginNodeSlot | undefined {
		const node = this.slots.lookupNode(inputAddress)
		if (!node) return undefined
		const current = this.nodeRecord(node)
		if (!current) return undefined

		this.deleteOutgoingBindings(node)
		this.setNodeRecord(node, undefined)
		const definition = current.definition.slot
		this.removeDefinitionNode(definition, node)
		if (this.definitionNodeCount(definition) === 0) {
			this.setDefinitionRecord(definition, undefined)
		}
		this.dirtyDefinitions.add(definition)
		this.dirtyConsumers.add(node)
		this.draft.remove(node)
		return node
	}

	replaceDefinition(
		inputAddress: PluginDefinitionAddress,
		candidate: ConcretePluginDefinitionCandidate,
	): readonly PluginNodeSlot[] {
		const address = parsePluginDefinitionAddress(inputAddress)
		this.assertCandidateAddress(candidate, address)
		const definition = this.slots.lookupDefinition(address)
		if (!definition) return Object.freeze([])
		const previous = this.definitionRecord(definition)
		if (!previous) return Object.freeze([])
		const family = [...this.definitionNodes(definition)]
		if (!candidate.declaration.forkable && family.some((node) => node.variant === 'fork')) {
			throw new TypeError(
				'[pluxel/core] Cannot remove forkability while fork nodes are materialized',
			)
		}

		const next = this.createDefinitionRecord(definition, candidate)
		this.setDefinitionRecord(definition, next)
		for (const node of family) {
			const nodeRecord = Object.freeze({
				address: this.slots.nodeAddress(node),
				slot: node,
				definition: next,
			})
			this.setNodeRecord(node, nodeRecord)
			this.dirtyConsumers.add(node)
			this.draft.replace(node, this.createProviderDeclaration(nodeRecord))
		}
		this.dirtyDefinitions.add(definition)
		return Object.freeze(family)
	}

	restartNode(inputAddress: PluginNodeAddress): PluginNodeSlot {
		const node = this.slots.lookupNode(inputAddress)
		if (!node || !this.nodeRecord(node))
			throw new Error('[pluxel/core] Cannot restart an absent Plugin node')
		return node
	}

	setProviderDefault(
		inputToken: PluginDefinitionAddress,
		inputProvider: PluginNodeAddress | null,
	): void {
		const token = this.slots.lookupDefinition(inputToken)
		if (!token) {
			if (inputProvider === null) return
			throw new Error('[pluxel/core] Provider default token is absent')
		}
		const previous = this.providerDefault(token)
		const provider = inputProvider === null ? undefined : this.slots.lookupNode(inputProvider)
		if (inputProvider !== null && !provider) {
			throw new Error('[pluxel/core] Provider default target is absent')
		}
		if (previous === provider) return
		this.pendingProviderDefaults.set(token, provider ?? null)
		this.dirtyProviderTokens.add(token)
		for (const node of [previous, provider]) {
			if (!node) continue
			const record = this.nodeRecord(node)
			if (record) this.draft.replace(node, this.createProviderDeclaration(record))
		}
	}

	setDependencyOverride(
		inputConsumer: PluginNodeAddress,
		inputRequirement: PluginDefinitionAddress,
		inputProvider: PluginNodeAddress | null,
	): void {
		const consumer = this.slots.lookupNode(inputConsumer)
		if (!consumer || !this.nodeRecord(consumer)) {
			throw new Error('[pluxel/core] Dependency override consumer is absent')
		}
		const requirement = this.slots.lookupDefinition(inputRequirement)
		if (!requirement) {
			throw new Error('[pluxel/core] Dependency override requirement is absent')
		}
		const current = new Map(this.consumerBindings(consumer))
		const previous = current.get(requirement)
		if (inputProvider === null) {
			if (!previous) return
			current.delete(requirement)
			this.removeInboundBinding(previous)
		} else {
			const provider = this.slots.lookupNode(inputProvider)
			if (!provider || !this.nodeRecord(provider)) {
				throw new Error('[pluxel/core] Dependency override provider is absent')
			}
			if (previous?.provider === provider) return
			if (previous) this.removeInboundBinding(previous)
			const binding = Object.freeze({ consumer, requirement, provider })
			current.set(requirement, binding)
			this.addInboundBinding(binding)
		}
		this.pendingBindingsByConsumer.set(consumer, current.size === 0 ? null : current)
		this.dirtyConsumers.add(consumer)
		const node = this.nodeRecord(consumer)
		if (node) this.draft.replace(consumer, this.createProviderDeclaration(node))
	}

	resetDraft(): void {
		this.draft.reset()
		this.clearPendingState()
	}

	build() {
		const structural = this.validateStructuralState()
		if (structural) {
			return createErr({ err: structural, reset: () => this.resetDraft() })
		}
		const built = this.draft.build()
		if (built.ok === false) {
			return createErr({
				err: this.enrichGraphBuildError(built.err as GraphBuildErrorType),
				reset: () => this.resetDraft(),
			})
		}
		assertPluginGraphDelta(built.val.delta)
		const graph = built.val.graph
		const runtime =
			this.committedRuntime?.graph === graph ? this.committedRuntime : built.val.runtime
		let confirmed = false
		const ret: BuildRet = {
			graph,
			runtime,
			delta: built.val.delta,
			confirm: () => {
				if (confirmed) return
				confirmed = true
				built.val.commit()
				this.confirmPendingState()
				this.committedRuntime = runtime
			},
		}
		return createOk(ret)
	}

	private createDefinitionRecord(
		slot: PluginDefinitionSlot,
		candidate: ConcretePluginDefinitionCandidate,
	): ConcretePluginDefinitionRecord {
		const declaration = candidate.declaration
		const revision = (this.nextRevision.get(slot) ?? 0) + 1
		this.nextRevision.set(slot, revision)
		const record: ConcretePluginDefinitionRecord = Object.freeze({
			address: this.slots.definitionAddress(slot),
			slot,
			implementation: candidate.implementation,
			revision,
			displayName: declaration.displayName,
			...(declaration.startTimeoutMs === undefined
				? {}
				: { startTimeoutMs: declaration.startTimeoutMs }),
			constructorRequires: Object.freeze(
				declaration.constructorRequires.map((address) => this.slots.internDefinition(address)),
			),
			requires: Object.freeze(
				declaration.requires.map((address) => this.slots.internDefinition(address)),
			),
			optional: Object.freeze(
				declaration.optional.map((address) => this.slots.internDefinition(address)),
			),
			dependencyRequests: Object.freeze(
				declaration.dependencyRequests.map((request) =>
					Object.freeze({
						definition: this.slots.internDefinition(request.definition),
						mode: request.mode,
						partPath: request.partPath,
					}),
				),
			),
			...(declaration.provides === undefined
				? {}
				: { provides: this.slots.internDefinition(declaration.provides) }),
			...(declaration.config === undefined ? {} : { config: declaration.config }),
			parts: declaration.parts,
			forkable: declaration.forkable,
		})
		this.candidateByRecord.set(record, candidate)
		return record
	}

	private createProviderDeclaration(node: PluginNodeRecord) {
		const record = node.definition
		const bindings = this.consumerBindings(node.slot)
		const deps = record.requires.map(
			(requirement) => bindings.get(requirement)?.provider ?? requirement,
		)
		const tokens: PluginDefinitionSlot[] = []
		if (node.slot.variant === 'default') {
			tokens.push(record.slot)
			if (record.provides && this.providerDefault(record.provides) === node.slot) {
				tokens.push(record.provides)
			}
		}
		return factoryProvider<BasePlugin, PluginNodeRecord>({
			key: node.slot,
			tokens,
			deps,
			optionalDeps: record.optional,
			meta: node,
			use: (...resolvedDependencies) => this.instantiateNode(node, resolvedDependencies),
		})
	}

	private instantiateNode(
		node: PluginNodeRecord,
		resolvedDependencies: readonly unknown[],
	): BasePlugin {
		const pluginContext = this.createPluginContext()
		const partContexts = new Set<Context>()
		installPluginGenerationInfo(pluginContext, node)
		try {
			if (resolvedDependencies.length !== node.definition.requires.length) {
				throw new Error('[pluxel/core] Resolved Plugin requirements do not match graph facts')
			}
			const resolvedByRequirement = new Map<string, BasePlugin>()
			for (let index = 0; index < node.definition.requires.length; index++) {
				const requirement = node.definition.requires[index]!
				resolvedByRequirement.set(
					pluginDefinitionIndexKey(this.slots.definitionAddress(requirement)),
					resolvedDependencies[index] as BasePlugin,
				)
			}
			const resolveRequirement: PluginRequirementResolver = (requirement, consumer) => {
				const provider = resolvedByRequirement.get(pluginDefinitionIndexKey(requirement))
				if (!provider) {
					throw new Error(
						`[pluxel/core] Requirement ${requirement.exportName} was not aggregated onto the owning Plugin graph`,
					)
				}
				return createCallerGenerationView(provider, consumer)
			}
			return constructPluginGeneration(
				node.definition.implementation,
				pluginContext,
				node.definition.parts,
				node.definition.constructorRequires.map((requirement) =>
					this.slots.definitionAddress(requirement),
				),
				resolveRequirement,
				partContexts,
			)
		} catch (cause) {
			const cleanup = (async () => {
				await Promise.all([
					closeOwnerInvocations(pluginContext),
					...[...partContexts].map((ctx) => closeOwnerInvocations(ctx)),
				])
				try {
					await pluginContext.effects.dispose()
				} finally {
					await Promise.all([
						closeConsumerInvocations(pluginContext),
						...[...partContexts].map((ctx) => closeConsumerInvocations(ctx)),
					])
				}
			})()
			throw new PluginGenerationConstructionError(cause, cleanup)
		}
	}

	private validateStructuralState(): GraphBuildError | undefined {
		for (const definition of this.dirtyDefinitions) {
			const record = this.definitionRecord(definition)
			if (!record) continue
			if (this.abstractProviders(definition).size > 0) {
				return invalidDeclaration(
					this.definitionNodes(definition).values().next().value ?? definition,
					'A Plugin definition address cannot be both concrete and abstract',
				)
			}
			if (record.provides && this.definitionRecord(record.provides)) {
				return invalidDeclaration(
					this.definitionNodes(definition).values().next().value ?? definition,
					'A concrete Plugin definition cannot also be used as an abstract provider token',
				)
			}
			for (const node of this.definitionNodes(definition)) {
				if (node.variant === 'fork' && !record.forkable) {
					return invalidDeclaration(node, 'Plugin definition does not allow fork nodes')
				}
			}
			for (const binding of this.inboundFor(definition)) {
				const issue = this.validateBinding(binding)
				if (issue) return issue
			}
		}
		for (const token of this.dirtyProviderTokens) {
			const provider = this.providerDefault(token)
			if (!provider) continue
			const record = this.nodeRecord(provider)
			if (!record) return invalidDeclaration(provider, 'Provider default target is absent')
			if (provider.variant !== 'default') {
				return invalidDeclaration(provider, 'A fork node cannot be a provider default')
			}
			if (record.definition.provides !== token) {
				return invalidDeclaration(provider, 'Provider default is incompatible with its token')
			}
			if (this.definitionRecord(token)) {
				return invalidDeclaration(provider, 'Provider default token must be abstract')
			}
		}
		for (const consumer of this.dirtyConsumers) {
			for (const binding of this.consumerBindings(consumer).values()) {
				const issue = this.validateBinding(binding)
				if (issue) return issue
			}
		}
		return undefined
	}

	private enrichGraphBuildError(error: GraphBuildErrorType): GraphBuildErrorType {
		const diagnostics: Array<{
			kind: 'InvalidDeclaration'
			nodeKey: PluginNodeSlot
			message: string
		}> = []
		for (const issue of error.issues) {
			if (issue.kind !== 'CircularDependency') continue
			for (let index = 0; index + 1 < issue.chain.length; index++) {
				const consumer = issue.chain[index]
				const provider = issue.chain[index + 1]
				if (!isPluginNodeSlot(consumer) || !isPluginNodeSlot(provider)) continue
				const record = this.nodeRecord(consumer)
				const providerRecord = this.nodeRecord(provider)
				if (!record || !providerRecord) continue
				const requests = record.definition.dependencyRequests.filter((request) =>
					this.requestTargetsProvider(consumer, request.definition, provider),
				)
				if (requests.length === 0) continue
				const sources = requests.map((request) => {
					const location = request.mode === 'required' ? 'constructor' : 'init plugins.use()'
					const source =
						request.partPath.length === 0
							? `owner ${location}`
							: `Part ${request.partPath.join('.')} ${location}`
					const effective = record.definition.requires.includes(request.definition)
						? 'required'
						: 'optional'
					return `${source} (${request.mode}${request.mode === effective ? '' : `; effective ${effective}`})`
				})
				diagnostics.push({
					kind: 'InvalidDeclaration',
					nodeKey: consumer,
					message: `Plugin dependency cycle edge to ${providerRecord.definition.address.exportName} was requested by ${sources.join(', ')}`,
				})
			}
		}
		return diagnostics.length === 0 ? error : new GraphBuildError([...error.issues, ...diagnostics])
	}

	private requestTargetsProvider(
		consumer: PluginNodeSlot,
		requirement: PluginDefinitionSlot,
		provider: PluginNodeSlot,
	): boolean {
		const binding = this.consumerBindings(consumer).get(requirement)
		if (binding) return binding.provider === provider
		if (provider.variant !== 'default') return false
		const providerRecord = this.nodeRecord(provider)
		if (!providerRecord) return false
		if (providerRecord.definition.slot === requirement) return true
		return (
			providerRecord.definition.provides === requirement &&
			this.providerDefault(requirement) === provider
		)
	}

	private validateBinding(binding: DependencyBinding): GraphBuildError | undefined {
		const consumer = this.nodeRecord(binding.consumer)
		if (!consumer) {
			return invalidDeclaration(binding.consumer, 'Dependency override consumer is absent')
		}
		if (!consumer.definition.requires.includes(binding.requirement)) {
			return invalidDeclaration(
				binding.consumer,
				'Dependency override requirement is not declared by its consumer',
			)
		}
		const provider = this.nodeRecord(binding.provider)
		if (!provider) {
			return invalidDeclaration(binding.consumer, 'Dependency override provider is absent')
		}
		if (
			provider.definition.slot !== binding.requirement &&
			provider.definition.provides !== binding.requirement
		) {
			return invalidDeclaration(binding.consumer, 'Dependency override provider is incompatible')
		}
		return undefined
	}

	private assertCandidateAddress(
		candidate: ConcretePluginDefinitionCandidate,
		address: PluginDefinitionAddress,
	): void {
		if (
			!candidate ||
			typeof candidate !== 'object' ||
			typeof candidate.implementation !== 'function' ||
			!candidate.declaration ||
			!pluginDefinitionAddressEqual(candidate.declaration.address, address)
		) {
			throw new TypeError('[pluxel/core] Candidate definition address does not match operation')
		}
	}

	private definitionRecord(
		definition: PluginDefinitionSlot,
	): ConcretePluginDefinitionRecord | undefined {
		if (this.pendingDefinitions.has(definition)) {
			return this.pendingDefinitions.get(definition) ?? undefined
		}
		return this.definitions.get(definition)
	}

	private nodeRecord(node: PluginNodeSlot): PluginNodeRecord | undefined {
		if (this.pendingNodes.has(node)) return this.pendingNodes.get(node) ?? undefined
		return this.nodes.get(node)
	}

	private definitionNodes(definition: PluginDefinitionSlot): ReadonlySet<PluginNodeSlot> {
		const committed = this.nodesByDefinition.get(definition) ?? EMPTY_NODE_SET
		const delta = this.pendingNodeFamilyDeltas.get(definition)
		if (!delta) return committed
		const merged = new Set(committed)
		for (const node of delta.removed) merged.delete(node)
		for (const node of delta.added) merged.add(node)
		return merged
	}

	private providerDefault(token: PluginDefinitionSlot): PluginNodeSlot | undefined {
		if (this.pendingProviderDefaults.has(token)) {
			return this.pendingProviderDefaults.get(token) ?? undefined
		}
		return this.providerDefaults.get(token)
	}

	private consumerBindings(
		consumer: PluginNodeSlot,
	): ReadonlyMap<PluginDefinitionSlot, DependencyBinding> {
		if (this.pendingBindingsByConsumer.has(consumer)) {
			return this.pendingBindingsByConsumer.get(consumer) ?? EMPTY_BINDINGS
		}
		return this.bindingsByConsumer.get(consumer) ?? EMPTY_BINDINGS
	}

	private inboundFor(definition: PluginDefinitionSlot): ReadonlySet<DependencyBinding> {
		if (this.pendingInboundBindings.has(definition)) {
			return this.pendingInboundBindings.get(definition) ?? EMPTY_INBOUND
		}
		return this.inboundBindings.get(definition) ?? EMPTY_INBOUND
	}

	private abstractProviders(token: PluginDefinitionSlot): ReadonlySet<PluginDefinitionSlot> {
		if (this.pendingProvidersByAbstract.has(token)) {
			return this.pendingProvidersByAbstract.get(token) ?? EMPTY_DEFINITION_SET
		}
		return this.providersByAbstract.get(token) ?? EMPTY_DEFINITION_SET
	}

	private setDefinitionRecord(
		definition: PluginDefinitionSlot,
		record: ConcretePluginDefinitionRecord | undefined,
	): void {
		const previous = this.definitionRecord(definition)
		if (previous?.provides !== record?.provides) {
			if (previous?.provides) this.removeAbstractProvider(previous.provides, definition)
			if (record?.provides) this.addAbstractProvider(record.provides, definition)
			if (previous?.provides) this.dirtyProviderTokens.add(previous.provides)
			if (record?.provides) this.dirtyProviderTokens.add(record.provides)
		}
		this.pendingDefinitions.set(definition, record ?? null)
		this.dirtyDefinitions.add(definition)
	}

	private setNodeRecord(node: PluginNodeSlot, record: PluginNodeRecord | undefined): void {
		this.pendingNodes.set(node, record ?? null)
	}

	private definitionFamilyDelta(definition: PluginDefinitionSlot): DefinitionFamilyDelta {
		let delta = this.pendingNodeFamilyDeltas.get(definition)
		if (!delta) {
			delta = { added: new Set(), removed: new Set() }
			this.pendingNodeFamilyDeltas.set(definition, delta)
		}
		return delta
	}

	private addDefinitionNode(definition: PluginDefinitionSlot, node: PluginNodeSlot): void {
		const delta = this.definitionFamilyDelta(definition)
		if (!delta.removed.delete(node)) delta.added.add(node)
	}

	private removeDefinitionNode(definition: PluginDefinitionSlot, node: PluginNodeSlot): void {
		const delta = this.definitionFamilyDelta(definition)
		if (!delta.added.delete(node)) delta.removed.add(node)
	}

	private definitionNodeCount(definition: PluginDefinitionSlot): number {
		const committed = this.nodesByDefinition.get(definition)?.size ?? 0
		const delta = this.pendingNodeFamilyDeltas.get(definition)
		return delta ? committed + delta.added.size - delta.removed.size : committed
	}

	private addAbstractProvider(token: PluginDefinitionSlot, provider: PluginDefinitionSlot): void {
		const providers = new Set([...this.abstractProviders(token), provider])
		this.pendingProvidersByAbstract.set(token, providers)
	}

	private removeAbstractProvider(
		token: PluginDefinitionSlot,
		provider: PluginDefinitionSlot,
	): void {
		const providers = new Set(this.abstractProviders(token))
		providers.delete(provider)
		this.pendingProvidersByAbstract.set(token, providers.size === 0 ? null : providers)
	}

	private addInboundBinding(binding: DependencyBinding): void {
		const definition = binding.provider.definition
		const inbound = new Set([...this.inboundFor(definition), binding])
		this.pendingInboundBindings.set(definition, inbound)
		this.dirtyDefinitions.add(definition)
	}

	private removeInboundBinding(binding: DependencyBinding): void {
		const definition = binding.provider.definition
		const inbound = new Set(this.inboundFor(definition))
		inbound.delete(binding)
		this.pendingInboundBindings.set(definition, inbound.size === 0 ? null : inbound)
		this.dirtyDefinitions.add(definition)
	}

	private deleteOutgoingBindings(consumer: PluginNodeSlot): void {
		const bindings = this.consumerBindings(consumer)
		if (bindings.size === 0) return
		for (const binding of bindings.values()) this.removeInboundBinding(binding)
		this.pendingBindingsByConsumer.set(consumer, null)
	}

	private confirmPendingState(): void {
		applyOverlay(this.definitions, this.pendingDefinitions)
		applyOverlay(this.nodes, this.pendingNodes)
		for (const [definition, delta] of this.pendingNodeFamilyDeltas) {
			const family = this.nodesByDefinition.get(definition) ?? new Set<PluginNodeSlot>()
			for (const node of delta.removed) family.delete(node)
			for (const node of delta.added) family.add(node)
			if (family.size === 0) this.nodesByDefinition.delete(definition)
			else this.nodesByDefinition.set(definition, family)
		}
		applyOverlay(this.providerDefaults, this.pendingProviderDefaults)
		applyOverlay(this.bindingsByConsumer, this.pendingBindingsByConsumer)
		applyOverlay(this.inboundBindings, this.pendingInboundBindings)
		applyOverlay(this.providersByAbstract, this.pendingProvidersByAbstract)
		this.clearPendingState()
	}

	private clearPendingState(): void {
		this.pendingDefinitions.clear()
		this.pendingNodes.clear()
		this.pendingNodeFamilyDeltas.clear()
		this.pendingProviderDefaults.clear()
		this.pendingBindingsByConsumer.clear()
		this.pendingInboundBindings.clear()
		this.pendingProvidersByAbstract.clear()
		this.dirtyDefinitions.clear()
		this.dirtyConsumers.clear()
		this.dirtyProviderTokens.clear()
	}
}

const EMPTY_NODE_SET: ReadonlySet<PluginNodeSlot> = new Set()
const EMPTY_BINDINGS: ReadonlyMap<PluginDefinitionSlot, DependencyBinding> = new Map()
const EMPTY_INBOUND: ReadonlySet<DependencyBinding> = new Set()
const EMPTY_DEFINITION_SET: ReadonlySet<PluginDefinitionSlot> = new Set()

function installPluginGenerationInfo(
	ctx: Context,
	node: PluginNodeRecord,
): asserts ctx is PluginContext {
	const definition = node.definition
	pinContextValue(
		ctx,
		'pluginInfo',
		Object.freeze({
			nodeAddress: node.address,
			nodeSlot: node.slot,
			definitionAddress: definition.address,
			definitionRevision: definition.revision,
			displayName: definition.displayName,
		}),
	)
	generationInfoByContext.set(
		ctx,
		Object.freeze({
			definitionSlot: definition.slot,
			implementation: definition.implementation,
			...(definition.startTimeoutMs === undefined
				? {}
				: { startTimeoutMs: definition.startTimeoutMs }),
			...(definition.config === undefined ? {} : { config: definition.config }),
		}),
	)
}

function invalidDeclaration(nodeKey: object, message: string): GraphBuildError {
	return new GraphBuildError([{ kind: 'InvalidDeclaration', nodeKey, message }])
}

function applyOverlay<K, V>(target: Map<K, V>, overlay: ReadonlyMap<K, V | null>): void {
	for (const [key, value] of overlay) {
		if (value === null) target.delete(key)
		else target.set(key, value)
	}
}

function assertPluginGraphDelta(delta: GraphDelta): asserts delta is PluginGraphDelta {
	for (const key of delta.added) assertNode(key)
	for (const key of delta.removed) assertNode(key)
	for (const key of delta.affected) assertNode(key)
	for (const replacement of delta.replaced) {
		assertNode(replacement.from)
		assertNode(replacement.to)
	}
}

function assertNode(value: unknown): asserts value is PluginNodeSlot {
	if (!isPluginNodeSlot(value)) {
		throw new TypeError('[pluxel/core] Plugin graph produced a non-slot key')
	}
}
