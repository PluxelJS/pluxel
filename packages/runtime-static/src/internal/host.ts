import {
	Context,
	ForkablePlugin,
	formatPluginDefinitionAddress,
	formatPluginNodeAddress,
	isPluginLifecycleNotStartedIssue,
	pluginDefinitionAddressEqual,
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
	PluginSlotRegistry,
	type CommitSummary,
	type ForkablePluginConstructor,
	type PluginConstructor,
	type PluginDefinitionAddressSnapshot,
	type PluginLifecycleIssue,
	type PluginNodeAddressSnapshot,
	type PluginNodeSlot,
} from '@pluxel/core'
import type { ProductDescriptor } from '@pluxel/runtime/product'

import {
	createContextPluginLogPolicyStore,
	createRuntimeLogging,
	isPluginEnabled,
	isWorkbenchEnabled,
	setPluginEnabled,
	workbenchAdminAccess,
	withWorkbenchPluginContext,
	type RuntimeLogging,
	type RuntimeLoggingInput,
	type RuntimePluginDependencyInfo,
	type RuntimePluginSource,
	type RuntimeRouteCapabilities,
} from '@pluxel/runtime/internal/static-host'
import {
	buildCatalog,
	collectUnknownConfigEntries,
	diffCatalog,
	firstMissingDependency,
	readConfigSnapshot,
	type StaticRuntimeCatalog,
	type StaticRuntimeCatalogDiff,
	type StaticRuntimeCatalogEntryInternal,
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

type StaticRuntimePlanOptions =
	| { reason: 'startup' }
	| {
			reason: 'hmr'
			diff: StaticRuntimeCatalogDiff
			previous: StaticRuntimeCatalog
	  }

type StaticRuntimeNode = Readonly<{
	entry: StaticRuntimeCatalogEntryInternal
	nodeSlot: PluginNodeSlot
	nodeAddress: PluginNodeAddressSnapshot
	generation: PluginConstructor
}>

type StaticRuntimeRegistration = Readonly<{
	generation: PluginConstructor
	provideBase?: boolean
}>

type StaticRuntimeDraftOperation =
	| {
			type: 'register'
			node: StaticRuntimeNode
			binding: StaticRuntimeRegistration
	  }
	| {
			type: 'replace'
			node: StaticRuntimeNode
			from: StaticRuntimeRegistration
			to: StaticRuntimeRegistration
	  }
	| {
			type: 'unregister'
			nodeSlot: PluginNodeSlot
			address: PluginNodeAddressSnapshot
			binding: StaticRuntimeRegistration
	  }

type StaticRuntimeCatalogPlan = Readonly<{
	reason: StaticRuntimePlanOptions['reason']
	catalog: StaticRuntimeCatalog
	nodes: readonly StaticRuntimeNode[]
	enabled: ReadonlySet<PluginNodeSlot>
	blocked: ReadonlySet<PluginNodeSlot>
	operations: readonly StaticRuntimeDraftOperation[]
	entries: StaticRuntimeReportEntry[]
}>

export class StaticRuntimeHostImpl implements StaticRuntimeHost {
	public readonly ctx: Context
	private readonly catalogSlots = new PluginSlotRegistry()
	private catalog: StaticRuntimeCatalog
	private readonly registeredByNode = new Map<PluginNodeSlot, StaticRuntimeRegistration>()
	private started = false
	private disposed = false
	private report: StaticRuntimeStartupReport | undefined

	public readonly hmr: StaticRuntimeHmrController = {
		reload: (definition) => this.reload(definition),
	}

	public constructor(
		public definition: StaticRuntimeDefinition,
		public readonly options: StaticRuntimeHostOptions,
		private readonly logging: RuntimeLogging,
	) {
		const context = createStaticRuntimeContextConfig(options, logging)
		this.catalog = buildCatalog(definition, this.catalogSlots)
		this.ctx = new Context({
			name: definition.name,
			...context,
		})
		this.ctx.effects.defer(() => logging.dispose(), {
			tag: 'RuntimeLogging',
			phase: 'shutdown',
		})
		this.ctx.runtimeRoute = this.createRuntimeRoute()
	}

	private createRuntimeRoute(): RuntimeRouteCapabilities {
		const unknownSource = (): RuntimePluginSource => ({
			__typename: 'PluginSourceInfo',
			kind: 'unknown',
			moduleId: null,
			packageName: null,
			version: null,
			tag: null,
		})

		return {
			catalog: {
				resolve: (address) => this.resolveGeneration(address),
				resolveDefinition: (address) => this.resolveDefinition(address)?.generation,
				require: (address) => {
					const generation = this.resolveGeneration(address)
					if (!generation) {
						throw new Error(
							`Plugin node is not present in the static catalog: ${formatPluginNodeAddress(address)}`,
						)
					}
					return generation
				},
				listRegistered: () =>
					this.catalog.entries.map((entry) => ({
						address: entry.nodeAddress,
						ctor: entry.generation,
						displayName: entry.displayName,
						rootExportName: entry.rootExport,
					})),
			},
			lifecycle: {
				isRunning: (address) => {
					const generation = this.resolveGeneration(address)
					return generation ? this.ctx.registry.isRunning(generation) : false
				},
				enable: async (address, generation) => {
					const resolved = generation ?? this.requireGeneration(address)
					this.assertCurrentGeneration(address, resolved)
					await this.validateGenerationConfig(address)
					this.ctx.runtimeState.update((draft) => setPluginEnabled(draft, address, true))
					const nodeSlot = this.catalog.slots.internNode(address)
					this.registeredByNode.set(nodeSlot, { generation: resolved })
					this.syncActiveRegistrations()
				},
				enablePersisted: (address) => {
					this.ctx.runtimeState.update((draft) => setPluginEnabled(draft, address, true))
				},
				deactivate: (address, generation, options) => {
					this.assertCurrentGeneration(address, generation)
					this.ctx.registry.unregister(generation, { cascadeDependents: true })
					this.registeredByNode.delete(this.catalog.slots.internNode(address))
					if (!options.runtimeOnly) {
						this.ctx.runtimeState.update((draft) => setPluginEnabled(draft, address, false))
					}
					this.syncActiveRegistrations()
				},
				stop: (address, generation) => {
					this.assertCurrentGeneration(address, generation)
					this.ctx.registry.unregister(generation, { cascadeDependents: true })
					this.registeredByNode.delete(this.catalog.slots.internNode(address))
					this.syncActiveRegistrations()
				},
			},
			configMetadata: {
				getConfig: (address) => this.resolveDefinition(address.definition)?.config,
			},
			dependencies: {
				listDependencies: (address) => this.listDependencies(address),
				ensureForkBase: (definition) => {
					const generation = this.resolveDefinition(definition)?.generation
					if (!generation) return undefined
					const proto = (generation as { prototype?: unknown }).prototype
					return proto && proto instanceof ForkablePlugin ? generation : undefined
				},
			},
			source: {
				resolveSource: () => unknownSource(),
			},
		}
	}

	public async prepare(): Promise<void> {
		this.assertWorkbenchAvailable()
		await Promise.all([this.ctx.root.configService.ready, this.ctx.root.runtimeState.ready])
		await this.logging.initializePolicy(createContextPluginLogPolicyStore(this.ctx))
		await this.ctx.prepareServices()
	}

	public describeCatalog(): StaticRuntimeCatalogSnapshot {
		return {
			runtime: this.definition.name,
			plugins: this.catalog.entries.map((entry) => ({
				address: entry.nodeAddress,
				definition: entry.definitionAddress,
				displayName: entry.displayName,
				rootExportName: entry.rootExport,
				provenance: entry.provenance,
				generation: entry.generation,
			})),
		}
	}

	public lastReport(): StaticRuntimeStartupReport | undefined {
		return this.report
	}

	private assertWorkbenchAvailable(): void {
		if (!staticHostNeedsWorkbench(this.ctx.config)) return
		if (this.ctx.workbench.enabled) return
		throw new Error(
			'[runtime-static:workbench] enabled configuration was not installed before host startup.',
		)
	}

	public async start(): Promise<StaticRuntimeStartupReport> {
		if (this.disposed) throw new Error('[runtime-static] cannot start a disposed host')
		if (this.started) return this.report ?? this.createNoopReport()
		this.started = true
		const plan = await this.createCatalogPlan(this.catalog, { reason: 'startup' })
		this.report = await this.applyCatalogPlan(plan)
		return this.report
	}

	public async stop(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		try {
			this.ctx.registry.resetDraft()
			const update = this.ctx.registry.beginUpdate({ reason: 'shutdown' })
			try {
				for (const { generation } of this.registeredByNode.values()) {
					if (this.ctx.registry.isRegistered(generation)) update.unregister(generation)
				}
				const result = await update.commit({ rollbackOnFailure: false })
				if (!result.ok) update.rollback()
			} catch {
				update.rollback()
			}
		} finally {
			this.registeredByNode.clear()
			this.ctx.registry.resetDraft()
			try {
				await this.ctx.effects.dispose()
			} finally {
				await this.logging.dispose()
			}
		}
	}

	private async reload(definition: StaticRuntimeDefinition): Promise<StaticRuntimeHmrReport> {
		if (this.disposed) throw new Error('[runtime-static] cannot reload a disposed host')
		const previousDefinition = this.definition
		const previous = this.catalog
		const next = buildCatalog(definition, this.catalogSlots)
		const diff = diffCatalog(previous, next)

		this.definition = definition
		this.catalog = next
		try {
			const plan = await this.createCatalogPlan(next, {
				reason: 'hmr',
				diff,
				previous,
			})
			const report = await this.applyCatalogPlan(plan)
			const hmrReport: StaticRuntimeHmrReport = {
				...report,
				added: diff.added,
				removed: diff.removed,
				replaced: diff.replaced,
			}
			this.report = hmrReport
			return hmrReport
		} catch (error) {
			this.definition = previousDefinition
			this.catalog = previous
			throw error
		}
	}

	private createNoopReport(): StaticRuntimeStartupReport {
		return {
			runtime: this.definition.name,
			entries: this.resolveNodes(this.catalog).map((node) =>
				this.reportEntry(
					node,
					isPluginEnabled(this.ctx.runtimeState.snapshot(), node.nodeAddress)
						? 'started'
						: 'disabled',
				),
			),
		}
	}

	private async createCatalogPlan(
		catalog: StaticRuntimeCatalog,
		options: StaticRuntimePlanOptions,
	): Promise<StaticRuntimeCatalogPlan> {
		await Promise.all([this.ctx.root.configService.ready, this.ctx.root.runtimeState.ready])
		const nodes = this.resolveNodes(catalog)
		const entries: StaticRuntimeReportEntry[] = []
		const runtimeState = this.ctx.runtimeState.snapshot()

		const unknownAddresses = collectUnknownConfigEntries(
			readConfigSnapshot(this.ctx.configService),
			catalog,
			runtimeState.enabled,
		)
		for (const unknown of unknownAddresses) {
			if (
				options.reason === 'hmr' &&
				options.diff.removed.some((address) => pluginNodeAddressEqual(address, unknown))
			) {
				continue
			}
			entries.push(this.reportAddress(unknown, 'unknown-config-entry'))
		}

		if (options.reason === 'hmr') {
			for (const address of options.diff.removed) {
				entries.push(
					this.reportAddress(
						address,
						'catalog-drift',
						'Plugin was removed from the static catalog',
						options.previous,
					),
				)
			}
		}

		const enabled = new Set<PluginNodeSlot>()
		for (const node of nodes) {
			if (isPluginEnabled(runtimeState, node.nodeAddress)) enabled.add(node.nodeSlot)
			else entries.push(this.reportEntry(node, 'disabled'))
		}

		const validationTargets = this.collectValidationTargets(nodes, enabled, options)
		const blocked = await this.validatePlugins(validationTargets, entries)
		this.applyDependencyBlocks(nodes, catalog, enabled, blocked, entries)

		return {
			reason: options.reason,
			catalog,
			nodes,
			entries,
			enabled,
			blocked,
			operations: this.createDraftOperations(nodes, enabled, blocked),
		}
	}

	private resolveNodes(catalog: StaticRuntimeCatalog): StaticRuntimeNode[] {
		const nodes: StaticRuntimeNode[] = catalog.entries.map((entry) => ({
			entry,
			nodeSlot: entry.nodeSlot,
			nodeAddress: entry.nodeAddress,
			generation: entry.generation,
		}))
		for (const fork of this.ctx.runtimeState.snapshot().forks) {
			const base = this.resolveDefinition(fork.definition, catalog)
			if (!base) continue
			const proto = (base.generation as { prototype?: unknown }).prototype
			if (!proto || !(proto instanceof ForkablePlugin)) {
				throw new TypeError(
					`[runtime-static] persisted fork base is not forkable: ${formatPluginDefinitionAddress(fork.definition)}`,
				)
			}
			for (const forkId of fork.forkIds) {
				const generation = this.ctx.registry.fork(
					base.generation as ForkablePluginConstructor,
					forkId,
				)
				const nodeAddress = pluginNodeAddressOf(generation)
				nodes.push({
					entry: base,
					nodeSlot: catalog.slots.internNode(nodeAddress),
					nodeAddress,
					generation,
				})
			}
		}
		return nodes
	}

	private collectValidationTargets(
		nodes: readonly StaticRuntimeNode[],
		enabled: ReadonlySet<PluginNodeSlot>,
		options: StaticRuntimePlanOptions,
	): StaticRuntimeNode[] {
		if (options.reason === 'startup') return nodes.filter((node) => enabled.has(node.nodeSlot))
		return nodes.filter((node) => {
			if (!enabled.has(node.nodeSlot)) return false
			return this.registeredByNode.get(node.nodeSlot)?.generation !== node.generation
		})
	}

	private async validatePlugins(
		nodes: readonly StaticRuntimeNode[],
		entries: StaticRuntimeReportEntry[],
	): Promise<Set<PluginNodeSlot>> {
		const blocked = new Set<PluginNodeSlot>()
		for (const node of nodes) {
			const config = node.entry.config
			if (!config) continue
			try {
				await this.ctx.configService.ensureValidated(
					this.ctx.registry.internNodeAddress(node.nodeAddress),
					config.schema,
					{ missingObjectDefault: {} },
				)
			} catch (error) {
				blocked.add(node.nodeSlot)
				entries.push(this.reportEntry(node, 'config-invalid', errorMessage(error)))
			}
		}
		return blocked
	}

	private applyDependencyBlocks(
		nodes: readonly StaticRuntimeNode[],
		catalog: StaticRuntimeCatalog,
		enabled: ReadonlySet<PluginNodeSlot>,
		blocked: Set<PluginNodeSlot>,
		entries: StaticRuntimeReportEntry[],
	): void {
		let changed = true
		while (changed) {
			changed = false
			for (const node of nodes) {
				if (!enabled.has(node.nodeSlot) || blocked.has(node.nodeSlot)) continue
				const missing = firstMissingDependency(node.entry, catalog, enabled, blocked)
				if (!missing) continue
				blocked.add(node.nodeSlot)
				entries.push(
					this.reportEntry(
						node,
						'dependency-missing',
						`Missing required Plugin definition: ${formatPluginDefinitionAddress(missing.definition)}`,
					),
				)
				changed = true
			}
		}
	}

	private createDraftOperations(
		nodes: readonly StaticRuntimeNode[],
		enabled: ReadonlySet<PluginNodeSlot>,
		blocked: ReadonlySet<PluginNodeSlot>,
	): StaticRuntimeDraftOperation[] {
		const operations: StaticRuntimeDraftOperation[] = []
		const desired = new Set(nodes.map((node) => node.nodeSlot))

		for (const [nodeSlot, binding] of this.registeredByNode) {
			if (desired.has(nodeSlot)) continue
			operations.push({
				type: 'unregister',
				nodeSlot,
				address: this.catalog.slots.nodeAddress(nodeSlot),
				binding,
			})
		}

		for (const node of nodes) {
			const current = this.registeredByNode.get(node.nodeSlot)
			if (!enabled.has(node.nodeSlot) || blocked.has(node.nodeSlot)) {
				if (current) {
					operations.push({
						type: 'unregister',
						nodeSlot: node.nodeSlot,
						address: node.nodeAddress,
						binding: current,
					})
				}
				continue
			}

			const next = this.registrationFor(node.nodeAddress, node.generation, enabled, blocked)
			if (!current) {
				operations.push({ type: 'register', node, binding: next })
				continue
			}
			if (current.generation !== next.generation || current.provideBase !== next.provideBase) {
				operations.push({ type: 'replace', node, from: current, to: next })
			}
		}
		return operations
	}

	private async applyCatalogPlan(
		plan: StaticRuntimeCatalogPlan,
	): Promise<StaticRuntimeStartupReport> {
		const update = this.ctx.registry.beginUpdate({ reason: plan.reason })
		try {
			this.applyDraftOperations(plan.operations, update)
			for (const node of plan.nodes) {
				if (!plan.enabled.has(node.nodeSlot) || plan.blocked.has(node.nodeSlot)) continue
				this.applyPersistedOverrides(node.nodeAddress, node.generation, plan.enabled, plan.blocked)
			}
			const result = await update.commit({ rollbackOnFailure: false })
			if (!result.ok) {
				update.rollback()
				throw new Error('[runtime-static] catalog transaction failed', { cause: result.err })
			}
		} catch (error) {
			update.rollback()
			throw error
		}

		this.confirmDraftOperations(plan.operations)
		const commit = this.ctx.registry.lastCommit
		this.applyCommitResult(plan, commit)
		return {
			runtime: this.definition.name,
			entries: compactReportEntries(plan.entries),
			commit,
		}
	}

	private applyDraftOperations(
		operations: readonly StaticRuntimeDraftOperation[],
		update: ReturnType<Context['registry']['beginUpdate']>,
	): void {
		for (const operation of operations) {
			if (operation.type === 'register') {
				update.register(
					operation.binding.generation,
					operation.binding.provideBase === undefined
						? undefined
						: { provideBase: operation.binding.provideBase },
				)
				continue
			}
			if (operation.type === 'replace') {
				if (this.ctx.registry.isRegistered(operation.from.generation)) {
					update.replace(operation.from.generation, operation.to.generation, {
						cascadeDependents: true,
						provideBase: operation.to.provideBase,
					})
				} else {
					update.register(
						operation.to.generation,
						operation.to.provideBase === undefined
							? undefined
							: { provideBase: operation.to.provideBase },
					)
				}
				continue
			}
			if (this.ctx.registry.isRegistered(operation.binding.generation)) {
				update.unregister(operation.binding.generation, { cascadeDependents: true })
			}
		}
	}

	private confirmDraftOperations(operations: readonly StaticRuntimeDraftOperation[]): void {
		for (const operation of operations) {
			if (operation.type === 'register') {
				this.registeredByNode.set(operation.node.nodeSlot, operation.binding)
			} else if (operation.type === 'replace') {
				this.registeredByNode.set(operation.node.nodeSlot, operation.to)
			} else {
				this.registeredByNode.delete(operation.nodeSlot)
			}
		}
	}

	private applyCommitResult(
		plan: StaticRuntimeCatalogPlan,
		commit: CommitSummary | undefined,
	): void {
		const issueByNode = new Map<PluginNodeSlot, PluginLifecycleIssue>()
		for (const issue of commit?.lifecycleReport.issues ?? []) {
			if (!isPluginLifecycleNotStartedIssue(issue)) continue
			const address = this.ctx.registry.nodeAddressOf(issue.plugin)
			const node = plan.catalog.slots.internNode(address)
			if (!issueByNode.has(node)) issueByNode.set(node, issue)
		}
		for (const node of plan.nodes) {
			if (!plan.enabled.has(node.nodeSlot) || plan.blocked.has(node.nodeSlot)) continue
			const issue = issueByNode.get(node.nodeSlot)
			if (issue) {
				plan.entries.push(
					this.reportEntry(
						node,
						issue.kind === 'dependency-blocked' ? 'dependency-failed' : 'start-failed',
						issue.message,
					),
				)
			} else if (this.ctx.registry.isRunning(node.generation)) {
				plan.entries.push(this.reportEntry(node, 'started'))
			}
		}
	}

	private resolveGeneration(
		address: PluginNodeAddressSnapshot,
		catalog: StaticRuntimeCatalog = this.catalog,
	): PluginConstructor | undefined {
		const node = catalog.slots.internNode(address)
		if (address.instance === 'default') return catalog.byNode.get(node)?.generation
		const base = this.resolveDefinition(address.definition, catalog)?.generation
		if (!base) return undefined
		const proto = (base as { prototype?: unknown }).prototype
		if (!proto || !(proto instanceof ForkablePlugin)) return undefined
		return this.ctx.registry.fork(base as ForkablePluginConstructor, address.forkId)
	}

	private requireGeneration(address: PluginNodeAddressSnapshot): PluginConstructor {
		const generation = this.resolveGeneration(address)
		if (!generation) {
			throw new Error(
				`Plugin node is not present in the static catalog: ${formatPluginNodeAddress(address)}`,
			)
		}
		return generation
	}

	private assertCurrentGeneration(
		address: PluginNodeAddressSnapshot,
		generation: PluginConstructor,
	): void {
		const current = this.requireGeneration(address)
		if (
			current !== generation ||
			!pluginNodeAddressEqual(pluginNodeAddressOf(generation), address)
		) {
			throw new Error(
				`Plugin constructor is not the current static catalog generation for ${formatPluginNodeAddress(address)}`,
			)
		}
	}

	private resolveDefinition(
		address: PluginDefinitionAddressSnapshot,
		catalog: StaticRuntimeCatalog = this.catalog,
	): StaticRuntimeCatalogEntryInternal | undefined {
		return catalog.byDefinition.get(catalog.slots.internDefinition(address))
	}

	private registrationFor(
		address: PluginNodeAddressSnapshot,
		generation: PluginConstructor,
		enabled: ReadonlySet<PluginNodeSlot>,
		blocked: ReadonlySet<PluginNodeSlot>,
	): StaticRuntimeRegistration {
		const entry = this.resolveDefinition(address.definition)
		if (!entry?.provides) return { generation }
		if (address.instance === 'fork') return { generation, provideBase: false }
		const selected = this.selectProvider(entry.provides, enabled, blocked)
		return {
			generation,
			provideBase: selected ? pluginNodeAddressEqual(selected, address) : false,
		}
	}

	private syncActiveRegistrations(): void {
		const enabled = new Set(this.registeredByNode.keys())
		const blocked = new Set<PluginNodeSlot>()
		for (const [nodeSlot, current] of this.registeredByNode) {
			const address = this.catalog.slots.nodeAddress(nodeSlot)
			const next = this.registrationFor(address, current.generation, enabled, blocked)
			if (
				!this.ctx.registry.isRegistered(current.generation) ||
				current.provideBase !== next.provideBase
			) {
				this.ctx.registry.register(
					next.generation,
					next.provideBase === undefined ? undefined : { provideBase: next.provideBase },
				)
			}
			this.registeredByNode.set(nodeSlot, next)
		}
		for (const [nodeSlot, binding] of this.registeredByNode) {
			this.applyPersistedOverrides(
				this.catalog.slots.nodeAddress(nodeSlot),
				binding.generation,
				enabled,
				blocked,
			)
		}
	}

	private selectProvider(
		definition: import('@pluxel/core').PluginDefinitionSlot,
		enabled: ReadonlySet<PluginNodeSlot>,
		blocked: ReadonlySet<PluginNodeSlot>,
	): PluginNodeAddressSnapshot | undefined {
		const candidates = (this.catalog.providersByDefinition.get(definition) ?? []).filter(
			(entry) => enabled.has(entry.nodeSlot) && !blocked.has(entry.nodeSlot),
		)
		const definitionAddress = this.catalog.slots.definitionAddress(definition)
		const persisted = this.ctx.runtimeState
			.snapshot()
			.providerDefaults.find((item) =>
				pluginDefinitionAddressEqual(item.token, definitionAddress),
			)?.provider
		if (persisted) {
			const selected = candidates.find((entry) =>
				pluginNodeAddressEqual(entry.nodeAddress, persisted),
			)
			if (selected) return selected.nodeAddress
		}
		return candidates
			.slice()
			.sort((left, right) =>
				formatPluginNodeAddress(left.nodeAddress).localeCompare(
					formatPluginNodeAddress(right.nodeAddress),
				),
			)[0]?.nodeAddress
	}

	private applyPersistedOverrides(
		consumer: PluginNodeAddressSnapshot,
		generation: PluginConstructor,
		enabled: ReadonlySet<PluginNodeSlot>,
		blocked: ReadonlySet<PluginNodeSlot>,
	): void {
		const entry = this.resolveDefinition(consumer.definition)
		if (!entry || entry.required.length === 0) return
		const state = this.ctx.runtimeState.snapshot()
		const overrides = entry.required.map((definition, parameterIndex) => {
			const definitionAddress = this.catalog.slots.definitionAddress(definition)
			const explicit = state.dependencyOverrides.find(
				(item) =>
					item.parameterIndex === parameterIndex && pluginNodeAddressEqual(item.consumer, consumer),
			)?.provider
			const fallback = state.providerDefaults.find((item) =>
				pluginDefinitionAddressEqual(item.token, definitionAddress),
			)?.provider
			const selected = explicit ?? fallback ?? this.selectProvider(definition, enabled, blocked)
			return selected ? this.ctx.registry.internNodeAddress(selected) : undefined
		})
		this.ctx.registry.replaceRuntimeDependencyOverrides(
			this.ctx.registry.internNodeAddress(pluginNodeAddressOf(generation)),
			overrides,
		)
	}

	private async validateGenerationConfig(address: PluginNodeAddressSnapshot): Promise<void> {
		const config = this.resolveDefinition(address.definition)?.config
		if (!config) return
		await this.ctx.configService.ensureValidated(
			this.ctx.registry.internNodeAddress(address),
			config.schema,
			{ missingObjectDefault: {} },
		)
	}

	private listDependencies(address: PluginNodeAddressSnapshot): RuntimePluginDependencyInfo {
		const consumer = this.ctx.registry.internNodeAddress(address)
		const graphDependencies = this.ctx.registry.graph.depsOf(consumer)
		const output: RuntimePluginDependencyInfo = []
		for (const dependency of graphDependencies) {
			if (!dependency || typeof dependency !== 'object') continue
			const nodeAddress = this.ctx.registry.nodeAddressOf(dependency as PluginNodeSlot)
			const generation = this.resolveGeneration(nodeAddress)
			const entry = this.resolveDefinition(nodeAddress.definition)
			output.push({
				address: nodeAddress,
				displayName: entry?.displayName ?? nodeAddress.definition.exportName,
				isRunning: generation ? this.ctx.registry.isRunning(generation) : false,
			})
		}
		return output
	}

	private reportEntry(
		node: StaticRuntimeNode,
		status: StaticRuntimeReportEntry['status'],
		message?: string,
	): StaticRuntimeReportEntry {
		return {
			address: node.nodeAddress,
			displayName: node.entry.displayName,
			rootExportName: node.entry.rootExport,
			status,
			...(message === undefined ? {} : { message }),
		}
	}

	private reportAddress(
		address: PluginNodeAddressSnapshot,
		status: StaticRuntimeReportEntry['status'],
		message?: string,
		catalog: StaticRuntimeCatalog = this.catalog,
	): StaticRuntimeReportEntry {
		const entry = this.resolveDefinition(address.definition, catalog)
		return {
			address,
			displayName: entry?.displayName ?? address.definition.exportName,
			rootExportName: address.definition.exportName,
			status,
			...(message === undefined ? {} : { message }),
		}
	}
}

export async function createStaticRuntimeHost(
	definition: StaticRuntimeDefinition,
	options: StaticRuntimeHostOptions = {},
	internal: {
		deployment?: StaticRuntimeHostDeployment
		installWorkbench?: StaticRuntimeWorkbenchInstaller
		product?: ProductDescriptor | null
	} = {},
): Promise<StaticRuntimeHost> {
	const logging = createRuntimeLogging(resolveStaticRuntimeLoggingInput(definition, options))
	await logging.install()
	let host: StaticRuntimeHostImpl | undefined
	try {
		host = new StaticRuntimeHostImpl(
			definition,
			withStaticRuntimeDeployment(options, internal.deployment),
			logging,
		)
		if (isWorkbenchEnabled(options.workbench)) {
			if (!internal.installWorkbench) {
				throw new Error('[runtime-static] Workbench installer is not available for this host')
			}
			internal.installWorkbench(host.ctx, { product: internal.product ?? null })
		}
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

export type StaticRuntimeWorkbenchInstaller = (
	ctx: Context,
	options: { product: ProductDescriptor | null },
) => void

function withStaticRuntimeDeployment(
	options: StaticRuntimeHostOptions,
	deployment: StaticRuntimeHostDeployment | undefined,
): StaticRuntimeHostOptions {
	if (!deployment) return options
	const context = options.context ?? {}
	const http = options.http
	return {
		...options,
		http: {
			...(http && typeof http === 'object' ? http : {}),
			...(deployment.publicDir ? { uiPublicDir: deployment.publicDir } : {}),
		} as StaticRuntimeHostOptions['http'],
		context: {
			...context,
			nodeModuleArtifactRoot: deployment.nodeModulesDir,
			...(deployment.workbenchDir ? { workbenchArtifactRoot: deployment.workbenchDir } : {}),
		} as StaticRuntimeHostOptions['context'],
	}
}

function resolveStaticRuntimeLoggingInput(
	definition: StaticRuntimeDefinition,
	options: StaticRuntimeHostOptions,
): RuntimeLoggingInput {
	if (options.logging !== undefined && options.logging !== false) return options.logging
	const root = {
		profile: options.profile ?? definition.name,
		debugTopics: resolveStaticDebugTopics(options.context?.debug),
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
		console: {
			kind: 'console',
			format: 'pretty',
			caller: false,
			timezone: 'local',
		},
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

function compactReportEntries(
	entries: readonly StaticRuntimeReportEntry[],
): StaticRuntimeReportEntry[] {
	const out: StaticRuntimeReportEntry[] = []
	const seen = new Set<string>()
	for (const entry of entries) {
		const key = `${formatPluginNodeAddress(entry.address)}\0${entry.status}\0${entry.message ?? ''}`
		if (seen.has(key)) continue
		seen.add(key)
		out.push(entry)
	}
	return out
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}

function staticHostNeedsWorkbench(ctxConfig: unknown): boolean {
	if (!ctxConfig || typeof ctxConfig !== 'object') return false
	const cfg = ctxConfig as {
		workbench?: { enabled?: unknown } | false
	}
	return cfg.workbench !== false && cfg.workbench?.enabled === true
}

function createStaticRuntimeContextConfig(
	options: StaticRuntimeHostOptions,
	logging: RuntimeLogging,
): import('@pluxel/core').Context.Config {
	const context = options.context ?? {}
	const configService = options.configService
	const http = options.http
	const workbench = options.workbench ?? false
	const adminAccess = workbenchAdminAccess(workbench)
	const persistence = options.persistence
	const database = options.database
	const profile = options.profile
	const inheritedRuntimeState =
		!options.runtimeState && configService?.mode ? { mode: configService.mode } : undefined
	const runtimeState = options.runtimeState ?? inheritedRuntimeState

	return withWorkbenchPluginContext({
		...context,
		http: {
			...(http && typeof http === 'object' ? http : {}),
		},
		adminAccess,
		workbench,
		profile,
		configService,
		runtimeState,
		persistence,
		database,
		logger: logging.contextBinding,
	})
}
