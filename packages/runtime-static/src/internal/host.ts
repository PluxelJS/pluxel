import {
	type CommitSummary,
	ForkablePlugin,
	isPluginLifecycleNotStartedIssue,
	type PluginConstructor,
	type PluginIdentifier,
	type PluginLifecycleIssue,
	Context,
} from '@pluxel/core'
import { isPluginEnabled, setPluginEnabled } from '@pluxel/runtime/runtime-state'
import type {
	RuntimePluginDependencyInfo,
	RuntimePluginSource,
	RuntimeRouteCapabilities,
} from '@pluxel/runtime/plugin-catalog'
import {
	isWorkbenchEnabled,
	workbenchAdminAccess,
	withWorkbenchPluginContext,
} from '@pluxel/runtime/internal'
import {
	buildCatalog,
	collectUnknownConfigEntries,
	diffCatalog,
	firstMissingDependency,
	readConfigSnapshot,
	type ConfigSnapshotReader,
	type StaticRuntimeCatalog,
	type StaticRuntimeCatalogDiff,
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
	  }

type StaticRuntimeDraftOperation =
	| {
			readonly type: 'register'
			readonly name: string
			readonly plugin: PluginConstructor
	  }
	| {
			readonly type: 'replace'
			readonly name: string
			readonly from: PluginConstructor
			readonly to: PluginConstructor
	  }
	| {
			readonly type: 'unregister'
			readonly name: string
			readonly plugin: PluginConstructor
	  }

type StaticRuntimeCatalogPlan = {
	readonly reason: StaticRuntimePlanOptions['reason']
	readonly catalog: StaticRuntimeCatalog
	readonly enabled: ReadonlySet<string>
	readonly blocked: ReadonlySet<string>
	readonly operations: readonly StaticRuntimeDraftOperation[]
	readonly entries: StaticRuntimeReportEntry[]
}

export class StaticRuntimeHostImpl implements StaticRuntimeHost {
	public readonly ctx: Context
	private catalog: StaticRuntimeCatalog
	private readonly registeredByName = new Map<string, PluginConstructor>()
	private started = false
	private disposed = false
	private report: StaticRuntimeStartupReport | undefined

	public readonly hmr: StaticRuntimeHmrController = {
		reload: (definition) => this.reload(definition),
	}

	public constructor(
		public definition: StaticRuntimeDefinition,
		public readonly options: StaticRuntimeHostOptions,
	) {
		const context = createStaticRuntimeContextConfig(options)
		this.catalog = buildCatalog(definition)
		this.ctx = new Context({
			name: definition.name,
			...context,
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

		const route: RuntimeRouteCapabilities = {
			catalog: {
				resolve: (target) => {
					if (typeof target === 'string') {
						return this.catalog.byName.get(target)?.plugin ?? this.registeredByName.get(target)
					}
					return this.catalog.byPlugin.get(target)?.plugin ?? target
				},
				resolveOrRegistered: (name) =>
					this.registeredByName.get(name) ?? this.catalog.byName.get(name)?.plugin,
				require: (name) => {
					const ctor = route.catalog.resolveOrRegistered(name)
					if (!ctor) throw new Error(`Plugin not found: ${name}`)
					return ctor
				},
				listRegistered: () =>
					new Map(this.catalog.entries.map((entry) => [entry.name, entry.plugin])),
				listLoadedNames: () => this.catalog.entries.map((entry) => entry.name),
			},
			lifecycle: {
				isRunning: (target) => {
					const ctor = route.catalog.resolve(target)
					return ctor ? this.ctx.registry.isRunning(ctor) : false
				},
				enable: (name, ctor) => {
					this.ctx.runtimeState.update((draft) => setPluginEnabled(draft, name, true))
					this.ctx.registry.register(ctor)
					this.registeredByName.set(name, ctor)
				},
				enablePersisted: (name) => {
					this.ctx.runtimeState.update((draft) => setPluginEnabled(draft, name, true))
				},
				deactivate: (name, ctor, options) => {
					this.ctx.registry.unregister(ctor)
					this.registeredByName.delete(name)
					if (!options.runtimeOnly) {
						this.ctx.runtimeState.update((draft) => setPluginEnabled(draft, name, false))
					}
				},
				stop: (name, ctor) => {
					this.ctx.registry.unregister(ctor)
					this.registeredByName.delete(name)
				},
			},
			configMetadata: {
				getSchema: (name) => this.catalog.byName.get(name)?.info.configMap ?? undefined,
				getSchemaSource: () => undefined,
				getConfigLayout: (name) => this.catalog.byName.get(name)?.info.configLayoutMap ?? undefined,
			},
			dependencies: {
				listDependencies: (ctor): RuntimePluginDependencyInfo => {
					const entry = this.catalog.byPlugin.get(ctor)
					if (!entry) return []
					return entry.deps.map((dep) => {
						const depEntry = this.catalog.byPlugin.get(dep)
						const depCtor = depEntry?.plugin ?? dep
						return {
							name: depEntry?.name ?? describeStaticDependency(dep),
							isRunning: this.ctx.registry.isRunning(depCtor),
						}
					})
				},
				ensureForkBase: (baseName) => {
					const baseCtor = route.catalog.resolve(baseName)
					if (!baseCtor) return undefined
					const proto = (baseCtor as { prototype?: unknown }).prototype
					if (!proto || !(proto instanceof ForkablePlugin)) return undefined
					return baseCtor
				},
			},
			source: {
				resolveSource: () => unknownSource(),
			},
		}

		return route
	}

	public async prepare(): Promise<void> {
		this.assertWorkbenchAvailable()
		await Promise.all([this.ctx.root.configService.ready, this.ctx.root.runtimeState.ready])
		await this.ctx.prepareServices()
	}

	public describeCatalog(): StaticRuntimeCatalogSnapshot {
		return {
			runtime: this.definition.name,
			plugins: this.catalog.entries.map(({ name, plugin }) => ({ name, plugin })),
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
			const update = this.ctx.registry.beginUpdate({ reason: 'config' })
			try {
				for (const plugin of this.registeredByName.values()) {
					if (this.ctx.registry.isRegistered(plugin)) update.unregister(plugin)
				}
				const result = await update.commit({ rollbackOnFailure: false })
				if (!result.ok) update.rollback()
			} catch {
				update.rollback()
			}
		} finally {
			this.registeredByName.clear()
			this.ctx.registry.resetDraft()
			await this.ctx.effects.dispose()
		}
	}

	private async reload(definition: StaticRuntimeDefinition): Promise<StaticRuntimeHmrReport> {
		if (this.disposed) throw new Error('[runtime-static] cannot reload a disposed host')
		const previous = this.catalog
		const next = buildCatalog(definition)
		const diff = diffCatalog(previous, next)

		this.definition = definition
		this.catalog = next

		const plan = await this.createCatalogPlan(next, {
			reason: 'hmr',
			diff,
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
	}

	private createNoopReport(): StaticRuntimeStartupReport {
		return {
			runtime: this.definition.name,
			entries: this.catalog.entries.map(({ name }) => ({
				name,
				status: isPluginEnabled(this.ctx.runtimeState.snapshot(), name) ? 'started' : 'disabled',
			})),
		}
	}

	private async createCatalogPlan(
		catalog: StaticRuntimeCatalog,
		options: StaticRuntimePlanOptions,
	): Promise<StaticRuntimeCatalogPlan> {
		await Promise.all([this.ctx.root.configService.ready, this.ctx.root.runtimeState.ready])

		const entries: StaticRuntimeReportEntry[] = [...catalog.diagnostics]
		const configSnapshot = readConfigSnapshot(
			this.ctx.configService as unknown as ConfigSnapshotReader,
		)
		for (const unknown of collectUnknownConfigEntries(
			configSnapshot,
			catalog.byName,
			this.ctx.runtimeState.snapshot().enabled,
		)) {
			entries.push({ name: unknown, status: 'unknown-config-entry' })
		}

		if (options.reason === 'hmr') {
			for (const name of options.diff.removed) {
				entries.push({
					name,
					status: 'catalog-drift',
					message: 'plugin was removed from the static catalog',
				})
			}
		}

		const enabled = new Set<string>()
		const runtimeState = this.ctx.runtimeState.snapshot()
		for (const { name } of catalog.entries) {
			if (isPluginEnabled(runtimeState, name)) enabled.add(name)
		}

		for (const { name } of catalog.entries) {
			if (!enabled.has(name)) entries.push({ name, status: 'disabled' })
		}

		const validateNames = this.collectValidationTargets(catalog, enabled, options)
		const blocked = await this.validatePlugins(catalog, validateNames, entries)
		this.applyDependencyBlocks(catalog, enabled, blocked, entries)

		return {
			reason: options.reason,
			catalog,
			entries,
			enabled,
			blocked,
			operations: this.createDraftOperations(catalog, enabled, blocked, options),
		}
	}

	private collectValidationTargets(
		catalog: StaticRuntimeCatalog,
		enabled: ReadonlySet<string>,
		options: StaticRuntimePlanOptions,
	): Set<string> {
		const names = new Set<string>()
		if (options.reason === 'startup') {
			for (const name of enabled) names.add(name)
			return names
		}

		for (const { name, plugin } of catalog.entries) {
			if (!enabled.has(name)) continue
			const current = this.registeredByName.get(name)
			if (!current || current !== plugin) names.add(name)
		}
		return names
	}

	private async validatePlugins(
		catalog: StaticRuntimeCatalog,
		names: ReadonlySet<string>,
		entries: StaticRuntimeReportEntry[],
	): Promise<Set<string>> {
		const blocked = new Set<string>()
		for (const { name, info } of catalog.entries) {
			if (!names.has(name)) continue
			const schemaMap = info.configMap
			if (!schemaMap) continue
			try {
				await this.ctx.configService.ensureValidated(name, schemaMap, {
					missingObjectDefault: {},
				})
			} catch (error) {
				blocked.add(name)
				entries.push({
					name,
					status: 'config-invalid',
					message: errorMessage(error),
				})
			}
		}
		return blocked
	}

	private applyDependencyBlocks(
		catalog: StaticRuntimeCatalog,
		enabled: ReadonlySet<string>,
		blocked: Set<string>,
		entries: StaticRuntimeReportEntry[],
	): void {
		let changed = true
		while (changed) {
			changed = false
			for (const entry of catalog.entries) {
				if (!enabled.has(entry.name) || blocked.has(entry.name)) continue
				const missing = firstMissingDependency(entry, catalog, enabled, blocked)
				if (!missing) continue
				blocked.add(entry.name)
				entries.push({
					name: entry.name,
					status: 'dependency-missing',
					message: `missing dependency: ${missing}`,
				})
				changed = true
			}
		}
	}

	private createDraftOperations(
		catalog: StaticRuntimeCatalog,
		enabled: ReadonlySet<string>,
		blocked: ReadonlySet<string>,
		options: StaticRuntimePlanOptions,
	): StaticRuntimeDraftOperation[] {
		const operations: StaticRuntimeDraftOperation[] = []

		if (options.reason === 'hmr') {
			for (const name of options.diff.removed) {
				const current = this.registeredByName.get(name)
				if (!current) continue
				operations.push({ type: 'unregister', name, plugin: current })
			}
		}

		for (const entry of catalog.entries) {
			const current = this.registeredByName.get(entry.name)
			if (!enabled.has(entry.name) || blocked.has(entry.name)) {
				if (current) operations.push({ type: 'unregister', name: entry.name, plugin: current })
				continue
			}

			if (!current) {
				operations.push({ type: 'register', name: entry.name, plugin: entry.plugin })
				continue
			}
			if (current !== entry.plugin) {
				operations.push({
					type: 'replace',
					name: entry.name,
					from: current,
					to: entry.plugin,
				})
			}
		}

		return operations
	}

	private async applyCatalogPlan(
		plan: StaticRuntimeCatalogPlan,
	): Promise<StaticRuntimeStartupReport> {
		const update = this.ctx.registry.beginUpdate({
			reason: plan.reason,
		})
		let commit: CommitSummary | undefined
		try {
			this.applyDraftOperations(plan.operations, update)
			commit = await this.commitPlan(plan, update)
		} catch (error) {
			update.rollback()
			throw error
		}
		if (commit) this.confirmDraftOperations(plan.operations)
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
				update.register(operation.plugin)
				continue
			}
			if (operation.type === 'replace') {
				if (this.ctx.registry.isRegistered(operation.from)) {
					update.replace(operation.from, operation.to, { cascadeDependents: true })
				} else {
					update.register(operation.to)
				}
				continue
			}
			if (this.ctx.registry.isRegistered(operation.plugin)) {
				update.unregister(operation.plugin, { cascadeDependents: true })
			}
		}
	}

	private confirmDraftOperations(operations: readonly StaticRuntimeDraftOperation[]): void {
		for (const operation of operations) {
			if (operation.type === 'register') {
				this.registeredByName.set(operation.name, operation.plugin)
			} else if (operation.type === 'replace') {
				this.registeredByName.set(operation.name, operation.to)
			} else {
				this.registeredByName.delete(operation.name)
			}
		}
	}

	private async commitPlan(
		plan: StaticRuntimeCatalogPlan,
		update: ReturnType<Context['registry']['beginUpdate']>,
	): Promise<CommitSummary | undefined> {
		const result = await update.commit({ rollbackOnFailure: false })
		if (result.ok) return this.ctx.registry.lastCommit

		update.rollback()
		const message = errorMessage(result.err)
		if (plan.operations.length === 0) {
			plan.entries.push({
				name: this.definition.name,
				status: 'catalog-drift',
				message,
			})
			return undefined
		}

		for (const operation of plan.operations) {
			plan.entries.push({ name: operation.name, status: 'dependency-missing', message })
		}
		return undefined
	}

	private applyCommitResult(
		plan: StaticRuntimeCatalogPlan,
		commit: CommitSummary | undefined,
	): void {
		const issueByPlugin = new Map<string, PluginLifecycleIssue>()
		for (const issue of commit?.lifecycleReport.issues ?? []) {
			if (isPluginLifecycleNotStartedIssue(issue) && !issueByPlugin.has(String(issue.plugin))) {
				issueByPlugin.set(String(issue.plugin), issue)
			}
		}
		for (const { name, plugin } of plan.catalog.entries) {
			if (!plan.enabled.has(name) || plan.blocked.has(name)) continue
			const issue = issueByPlugin.get(name)
			if (issue) {
				plan.entries.push({
					name,
					status: issue.kind === 'dependency-blocked' ? 'dependency-failed' : 'start-failed',
					message: issue.message,
				})
			} else if (this.ctx.registry.isRunning(plugin)) {
				plan.entries.push({ name, status: 'started' })
			}
		}
	}
}

export async function createStaticRuntimeHost(
	definition: StaticRuntimeDefinition,
	options: StaticRuntimeHostOptions = {},
): Promise<StaticRuntimeHost> {
	const host = new StaticRuntimeHostImpl(definition, options)
	if (isWorkbenchEnabled(options.workbench)) {
		const { installWorkbench } = await import('@pluxel/runtime/internal')
		installWorkbench(host.ctx)
	}
	await host.prepare()
	return host
}

function compactReportEntries(
	entries: readonly StaticRuntimeReportEntry[],
): StaticRuntimeReportEntry[] {
	const out: StaticRuntimeReportEntry[] = []
	const seen = new Set<string>()
	for (const entry of entries) {
		const key = `${entry.name}\0${entry.status}\0${entry.message ?? ''}`
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

function describeStaticDependency(dep: PluginIdentifier): string {
	if (typeof dep !== 'function') return String(dep)
	return dep.name || '<anonymous>'
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
): NonNullable<StaticRuntimeHostOptions['context']> {
	const context = options.context ?? {}
	const configService = options.configService ?? context.configService
	const http = options.http ?? context.http
	const workbench = options.workbench ?? context.workbench ?? false
	const adminAccess = workbenchAdminAccess(workbench)
	const logger = options.logger ?? context.logger
	const persistence = options.persistence ?? context.persistence
	const pluginData = options.pluginData ?? context.pluginData
	const profile = options.profile ?? context.profile
	const inheritedRuntimeState =
		!options.runtimeState && !context.runtimeState && configService?.mode
			? { mode: configService.mode }
			: undefined
	const runtimeState = options.runtimeState ?? context.runtimeState ?? inheritedRuntimeState

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
		pluginData,
		logger,
	})
}
