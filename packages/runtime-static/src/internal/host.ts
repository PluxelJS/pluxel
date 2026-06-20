import {
	type CommitSummary,
	type PluginConstructor,
} from '@pluxel/core'
import { Context } from '@pluxel/runtime'
import { bootstrapHostVault } from '@pluxel/runtime/services'
import {
	buildCatalog,
	collectUnknownConfigEntries,
	diffCatalog,
	firstMissingDependency,
	readConfigSnapshot,
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
	| { mode: 'startup' }
	| {
			mode: 'hmr'
			previous: StaticRuntimeCatalog
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
	readonly mode: StaticRuntimePlanOptions['mode']
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
		const context = options.context ?? {}
		this.catalog = buildCatalog(definition)
		this.ctx = new Context({
			name: definition.name,
			...context,
			configService: options.configService ?? context.configService,
		})
	}

	public async prepare(): Promise<void> {
		await this.ctx.root.configService.ready
		await bootstrapHostVault(this.ctx)
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

	public async start(): Promise<StaticRuntimeStartupReport> {
		if (this.disposed) throw new Error('[runtime-static] cannot start a disposed host')
		if (this.started) return this.report ?? this.createNoopReport()
		this.started = true
		const plan = await this.createCatalogPlan(this.catalog, { mode: 'startup' })
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
			mode: 'hmr',
			previous,
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
				status: this.ctx.configService.isEnabledInConfig(name) ? 'started' : 'disabled',
			})),
		}
	}

	private async createCatalogPlan(
		catalog: StaticRuntimeCatalog,
		options: StaticRuntimePlanOptions,
	): Promise<StaticRuntimeCatalogPlan> {
		await this.ctx.root.configService.ready

		const entries: StaticRuntimeReportEntry[] = [...catalog.diagnostics]
		const configSnapshot = readConfigSnapshot(this.ctx.configService)
		for (const unknown of collectUnknownConfigEntries(configSnapshot, catalog.byName)) {
			entries.push({ name: unknown, status: 'unknown-config-entry' })
		}

		if (options.mode === 'hmr') {
			for (const name of options.diff.removed) {
				const previous = options.previous.byName.get(name)
				if (!previous) continue
				entries.push({
					name,
					status: 'catalog-drift',
					message: 'plugin was removed from the static catalog',
				})
			}
		}

		const enabled = new Set<string>()
		for (const { name } of catalog.entries) {
			if (this.ctx.configService.isEnabledInConfig(name)) enabled.add(name)
		}

		for (const { name } of catalog.entries) {
			if (!enabled.has(name)) entries.push({ name, status: 'disabled' })
		}

		const validateNames = this.collectValidationTargets(catalog, enabled, options)
		const blocked = await this.validatePlugins(catalog, validateNames, entries)
		this.applyDependencyBlocks(catalog, enabled, blocked, entries)

		return {
			mode: options.mode,
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
		if (options.mode === 'startup') {
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

		if (options.mode === 'hmr') {
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
			reason: plan.mode === 'hmr' ? 'hmr' : 'startup',
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
		if (plan.operations.length === 0) {
			const result = await update.commit({ rollbackOnFailure: false })
			if (!result.ok) {
				update.rollback()
				plan.entries.push({
					name: this.definition.name,
					status: 'catalog-drift',
					message: errorMessage(result.err),
				})
				return undefined
			}
			return this.ctx.registry.lastCommit
		}

		const result = await update.commit({ rollbackOnFailure: false })
		if (result.ok) return this.ctx.registry.lastCommit

		update.rollback()
		const message = errorMessage(result.err)
		for (const operation of plan.operations) {
			plan.entries.push({ name: operation.name, status: 'dependency-missing', message })
		}
		return undefined
	}

	private applyCommitResult(
		plan: StaticRuntimeCatalogPlan,
		commit: CommitSummary | undefined,
	): void {
		const failed = commit ? new Set(commit.failed.map(String)) : new Set<string>()
		for (const { name, plugin } of plan.catalog.entries) {
			if (!plan.enabled.has(name) || plan.blocked.has(name)) continue
			if (failed.has(name)) {
				plan.entries.push({ name, status: 'start-failed' })
			} else if (this.ctx.registry.isRunning(plugin)) {
				plan.entries.push({ name, status: 'started' })
			}
		}
	}
}

function compactReportEntries(entries: readonly StaticRuntimeReportEntry[]): StaticRuntimeReportEntry[] {
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
