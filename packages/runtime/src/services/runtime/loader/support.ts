import {
	type ConfigLayout,
	type Context,
	type ForkablePluginConstructor,
	getClassParams,
	getPluginInfo,
	parseForkPluginId,
	type PluginConstructor,
	type PluginIdentifier,
} from '@pluxel/core'
import type { ConfigSchemaMap } from '@pluxel/core/services'
import { getRuntimeModuleAdapter } from '../../../runtime/module-runtime'
import type { ModuleReplacer } from './module-replacer'
import type {
	PluginLifecycleSnapshot,
	PluginLifecycleStage,
	PluginRegistry,
} from './PluginRegistry'

export type RemovalScope = 'runtime' | 'persisted'

type StatusSummary = {
	total: number
	running: number
	stopped: number
	disabled: number
}

type PluginRegistryTx = ReturnType<PluginRegistry['beginTransaction']>

export type LoaderBatch = {
	replaceModule(moduleId: string, mod: Record<string, unknown>): Promise<boolean>
	listAffectedModules(): readonly string[]
	rollback(): void
	commit(): void
}

export class AnchorStore {
	private readonly anchors = new Set<string>()
	private readonly hmrAnchors = new Set<string>()
	private version = 0
	private snapshotVersion = -1
	private snapshotCache: ReadonlySet<string> = new Set<string>()

	has(id: string) {
		return this.anchors.has(id)
	}

	values(): IterableIterator<string> {
		return this.anchors.values()
	}

	snapshot(): ReadonlySet<string> {
		if (this.snapshotVersion === this.version) return this.snapshotCache
		const snap = new Set(this.hmrAnchors)
		this.snapshotCache = snap
		this.snapshotVersion = this.version
		return snap
	}

	add(id: string) {
		if (this.anchors.has(id)) return
		this.anchors.add(id)
		if (!id.includes('/node_modules/')) this.hmrAnchors.add(id)
		this.version++
	}

	delete(id: string) {
		if (!this.anchors.delete(id)) return
		this.hmrAnchors.delete(id)
		this.version++
	}
}

export class AnchorJournal {
	private readonly snapshot = new Map<string, boolean>()

	constructor(private readonly anchors: AnchorStore) {}

	record(id: string) {
		if (this.snapshot.has(id)) return
		this.snapshot.set(id, this.anchors.has(id))
	}

	update(id: string, isAnchor: boolean) {
		if (isAnchor) this.anchors.add(id)
		else this.anchors.delete(id)
	}

	rollback() {
		for (const [id, had] of this.snapshot) {
			if (had) this.anchors.add(id)
			else this.anchors.delete(id)
		}
	}

	commit() {
		this.snapshot.clear()
	}
}

export class LoaderBatchSession implements LoaderBatch {
	private readonly anchors: AnchorJournal
	private readonly affectedModules = new Set<string>()

	constructor(
		private readonly moduleReplacer: ModuleReplacer,
		private readonly tx: PluginRegistryTx,
		anchors: AnchorStore,
	) {
		this.anchors = new AnchorJournal(anchors)
	}

	async replaceModule(moduleId: string, mod: Record<string, unknown>) {
		const result = await this.moduleReplacer.replaceModule(moduleId, mod, {
			tx: this.tx,
			anchors: this.anchors,
		})
		for (const affected of result.affectedModules) this.affectedModules.add(affected)
		return result.isAnchor
	}

	listAffectedModules(): readonly string[] {
		return [...this.affectedModules]
	}

	rollback() {
		this.tx.rollback()
		this.anchors.rollback()
		this.affectedModules.clear()
	}

	commit() {
		this.tx.commit()
		this.anchors.commit()
		this.affectedModules.clear()
	}
}

export class RuntimeResolver {
	constructor(
		private readonly ctx: Context,
		private readonly registry: PluginRegistry,
	) {}

	resolve(target: PluginConstructor | string): PluginConstructor | undefined {
		if (typeof target === 'string') {
			const fork = parseForkPluginId(target)
			if (fork) {
				const baseCtor = this.registry.getPluginByName(fork.baseId)
				if (baseCtor) {
					try {
						return this.ctx.registry.fork(
							baseCtor as unknown as ForkablePluginConstructor,
							fork.forkId,
						) as PluginConstructor
					} catch {
						// fall through
					}
				}
			}
			return this.registry.getPluginByName(target)
		}
		const { id: name } = getPluginInfo(target)
		return this.registry.getPluginByName(name) ?? target
	}

	isRunning(target: PluginConstructor | string): boolean {
		const ctor = this.resolve(target)
		if (!ctor) return false
		return this.ctx.registry.isRunning(ctor)
	}

	normalizeId(moduleId: string) {
		return getRuntimeModuleAdapter(this.ctx).normalizeId(moduleId)
	}
}

export class PluginStatusReporter {
	constructor(
		private readonly registry: PluginRegistry,
		private readonly runtime: RuntimeResolver,
		private readonly isEnabled: (name: string) => boolean,
	) {}

	snapshot(): { statuses: Record<string, PluginLifecycleSnapshot>; summary: StatusSummary } {
		const loaded = this.registry.names
		const statuses: Record<string, PluginLifecycleSnapshot> = Object.create(null)
		let running = 0
		let stopped = 0
		let disabled = 0
		for (const [name, ctor] of loaded) {
			const isRunning = this.runtime.isRunning(ctor as PluginConstructor)
			const isEnabled = this.isEnabled(name)
			const lifecycleStage = this.deriveLifecycleStage(isRunning, isEnabled)
			statuses[name] = { id: name, isRunning, isEnabled, lifecycleStage }
			if (!isEnabled) disabled++
			else if (isRunning) running++
			else stopped++
		}
		return {
			statuses,
			summary: { total: running + stopped + disabled, running, stopped, disabled },
		}
	}

	private deriveLifecycleStage(isRunning: boolean, isEnabled: boolean): PluginLifecycleStage {
		if (!isEnabled) return 'disabled'
		return isRunning ? 'running' : 'stopped'
	}
}

export type PluginDependencyInfo = Array<{ name: string; isRunning: boolean }>

export class PluginDependencyInspector {
	constructor(private readonly ctx: Context) {}

	list(ctor: PluginConstructor): PluginDependencyInfo {
		return getClassParams<PluginConstructor>(ctor)
			.map((dep) => {
				if (typeof dep !== 'function') return undefined
				let name: string
				try {
					name = getPluginInfo(dep).id
				} catch {
					name = (dep as { name?: string }).name ?? String(dep)
				}
				// Core registry can resolve abstract/base tokens via DI aliases.
				const isRunning = this.ctx.registry.isRunning(dep as unknown as PluginIdentifier)
				return { name, isRunning }
			})
			.filter(Boolean) as Array<{ name: string; isRunning: boolean }>
	}
}

export class PluginPruner {
	constructor(
		private readonly ctx: Context,
		private readonly registry: PluginRegistry,
		private readonly anchors: AnchorStore,
	) {}

	pruneModule(moduleId: string, scope: RemovalScope = 'runtime') {
		const id = moduleId
		if (scope === 'persisted') this.registry.disablePersistedByModule(id)
		this.registry.stopModule(id)
		this.registry.undeclareModule(id)
		this.anchors.delete(id)
	}

	prunePluginByName(name: string, scope: RemovalScope = 'runtime') {
		const candidates = new Set<string>()
		const mapped = this.registry.name2PathMap.get(name)
		if (mapped) candidates.add(mapped)
		else {
			for (const [moduleId, items] of this.registry.modules) {
				if (
					items.some((item) => {
						try {
							return getPluginInfo(item.ctor).id === name
						} catch {
							return false
						}
					})
				) {
					candidates.add(moduleId)
				}
			}
		}

		if (candidates.size === 0) {
			// 没找到模块路径，至少停运行态/禁持久启用
			const ctor = this.registry.getPluginByName(name)
			if (ctor) this.registry.stopPlugin(name, ctor)
			if (scope === 'persisted') this.ctx.configService.disableInConfig(name)
			return
		}

		for (const moduleId of candidates) {
			this.pruneModule(moduleId, scope)
		}
	}
}

export class LoaderRegistryView {
	constructor(
		private readonly registry: PluginRegistry,
		private readonly runtime: RuntimeResolver,
	) {}

	listLoadedNames(): string[] {
		return this.registry.getLoadedNames()
	}

	listRegistered(): ReadonlyMap<string, PluginConstructor> {
		return this.registry.names
	}

	findModuleId(name: string, ctor?: PluginConstructor): string | null {
		const direct = this.registry.name2PathMap.get(name)
		if (direct) return direct
		const fork = parseForkPluginId(name)
		if (fork) {
			const base = this.registry.name2PathMap.get(fork.baseId)
			if (base) return base
		}
		if (!ctor) return null
		for (const [moduleId, modules] of this.registry.modules) {
			if (modules.some((item) => item.ctor === ctor)) {
				return moduleId
			}
		}
		return null
	}

	findModuleIdByName(name: string): string | null {
		return this.findModuleId(name)
	}

	getCtor(name: string): PluginConstructor | undefined {
		return this.registry.getPluginByName(name)
	}

	getExportKey(name: string): string | undefined {
		return this.registry.getExportKeyByName(name)
	}

	getSchema(target: PluginConstructor | string): ConfigSchemaMap | undefined {
		const ctor = this.runtime.resolve(target)
		if (!ctor) return undefined
		return this.registry.getSchema(ctor)
	}

	getSchemaSource(
		target: PluginConstructor | string,
	): Readonly<Record<string, string>> | undefined {
		const ctor = this.runtime.resolve(target)
		if (!ctor) return undefined
		return this.registry.getSchemaSource(ctor)
	}

	getConfigLayout(
		target: PluginConstructor | string,
	): Readonly<Record<string, ConfigLayout>> | undefined {
		const ctor = this.runtime.resolve(target)
		if (!ctor) return undefined
		return this.registry.getConfigLayout(ctor)
	}
}

export class LoaderAnchors {
	constructor(private readonly anchors: AnchorStore) {}

	has(moduleId: string): boolean {
		return this.anchors.has(moduleId)
	}

	/**
	 * List anchor module ids without exposing the underlying Set (prevents accidental mutation).
	 */
	list(): IterableIterator<string> {
		return this.anchors.values()
	}

	snapshot(): ReadonlySet<string> {
		return this.anchors.snapshot()
	}

	remove(moduleId: string) {
		this.anchors.delete(moduleId)
	}
}

export class LoaderControl {
	constructor(private readonly registry: PluginRegistry) {}

	enable(name: string, ctor: PluginConstructor) {
		return this.registry.enable(name, ctor)
	}

	enablePersisted(name: string) {
		return this.registry.enablePersisted(name)
	}

	deactivate(name: string, ctor: PluginConstructor, options: { runtimeOnly: boolean }) {
		this.registry.deactivate(name, ctor, options)
	}

	stop(name: string, ctor: PluginConstructor) {
		this.registry.stopPlugin(name, ctor)
	}
}

export type LoaderApi = {
	runtime: RuntimeResolver
	status: PluginStatusReporter
	deps: PluginDependencyInspector
	registry: LoaderRegistryView
	anchors: LoaderAnchors
	control: LoaderControl
}
