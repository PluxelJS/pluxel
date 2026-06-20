// PluginService.ts
// Runtime orchestrator for the plugin system.
//
// Design notes:
// - Non‑transactional commit: container definition switches even if some plugins fail.
// - "Failed" means "not running this cycle", *not* unregistered. As long as a plugin
//   remains registered in the container, future commits may retry it.
// - Performance first: heavy work is split into pure helpers without changing
//   construction/lifecycle hot paths.

import { Injectable, type Context as PluxelContext, type ServiceClass } from '@pluxel/context'
import { createErr, createOk } from 'option-t/plain_result'
import { isProduction } from '../../env'
import { EffectsService } from '../../services/effects/EffectsService'
import type { BasePlugin } from '../composition/BasePlugin'
import type { PluginInfo } from '../decorators/decorator/types'
import { getPluginInfo } from '../decorators/PluginDecorator'
// Optional dependency API removed in favor of feature composition (BaseFeature).
import type {
	ForkablePluginConstructor,
	PluginConstructor,
	PluginIdentifier,
	PluginInstance,
} from '../types'
import {
	computeInitPlan,
	type InitPlan,
	type PluginStartStrategy,
	startPluginsWithStrategy,
	stopPluginsTopo,
} from './commit'
import { forkPlugin, getForkedCtor, listForks } from './fork'
import {
	runtimePluginKeyOfCtor,
	runtimePluginKeyOfName,
	type RuntimePluginHandle,
	type RuntimePluginKey,
} from './identity'
import { LifecycleManager } from './LifecycleManager'
import { PluginDefinitions, type PluginGraph, type PluginRuntime } from './PluginDefinitions'
import { formatForkPluginId, parseForkPluginId } from './pluginId'

/* ─────────────────────────── Types ─────────────────────────── */

type PluginServiceConfig = {
	pluginCTXIsolate?: AnyServiceClass[]
	startTimeoutMs?: number
	stopTimeoutMs?: number
	startStrategy?: PluginStartStrategy
	startConcurrency?: number
	stopConcurrency?: number
	featureDeclarationPolicy?: 'off' | 'warn' | 'error'
}

type AnyServiceClass = ServiceClass<new (ctx: PluxelContext, cfg?: unknown) => unknown>
type CascadeOptions = { cascadeDependents?: boolean }
type ReplacePluginOptions = CascadeOptions & { provideBase?: boolean }
type PluginReplacement = { from: RuntimePluginKey; to: RuntimePluginKey }
type RuntimeUpdateReason = string

export type RuntimeUpdateOptions = {
	reason?: RuntimeUpdateReason
}

export type RuntimeModuleDeclarationItem = {
	ctor: PluginConstructor
	exportKey?: string
}

export type RuntimeModuleDeclaration = {
	moduleId: string
	items: readonly RuntimeModuleDeclarationItem[]
}

export type RuntimeUpdateCommitOptions = {
	/**
	 * Use strict commit semantics for this update.
	 *
	 * Strict commit returns an error result if any plugin fails to start.
	 */
	strict?: boolean
	/**
	 * Roll back core draft/pending restart state when commit returns an error.
	 *
	 * Defaults to true. Retry loops may set this to false, re-sync declarations, and call
	 * commit again before eventually committing or rolling back the transaction.
	 */
	rollbackOnFailure?: boolean
	/**
	 * Plugins that an adapter disabled while recovering this runtime update.
	 *
	 * Core records this in the commit summary only; the policy and persistence side effects
	 * remain owned by the adapter/control-plane layer.
	 */
	autoDisabled?: readonly RuntimePluginKey[]
}

export type RuntimeUpdateTransaction = {
	readonly reason: RuntimeUpdateReason
	register(Plugin: PluginConstructor, opts?: { provideBase?: boolean }): void
	unregister(id: PluginIdentifier, opts?: CascadeOptions): void
	replace(target: PluginIdentifier, next: PluginConstructor, opts?: ReplacePluginOptions): void
	upsertModule(module: RuntimeModuleDeclaration): void
	removeModule(moduleId: string): void
	touchModule(moduleId: string): void
	touchModules(moduleIds: Iterable<string>): void
	restart(id: PluginIdentifier, opts?: CascadeOptions): void
	commit(
		options?: RuntimeUpdateCommitOptions,
	): Promise<Awaited<ReturnType<PluginService['commit']>>>
	rollback(): void
}

type RuntimeUpdateCheckpoint = {
	pendingStart: Set<RuntimePluginKey>
	pendingRestart: Set<RuntimePluginKey>
	dependencyOverrides: Map<string, readonly (PluginIdentifier | undefined)[] | undefined>
}

type RuntimeModuleSnapshot =
	| {
			items: readonly RuntimeModuleDeclarationItem[]
			revision: number
	  }
	| undefined
type RuntimeUpdateCommitMeta = {
	reason: RuntimeUpdateReason
	touchedModules: readonly string[]
	autoDisabled: readonly RuntimePluginKey[]
}
type RuntimeUpdateController = {
	lastCommitSummary(): CommitSummary | undefined
	register(Plugin: PluginConstructor, opts?: { provideBase?: boolean }): void
	unregister(id: PluginIdentifier, opts?: CascadeOptions): void
	replace(target: PluginIdentifier, next: PluginConstructor, opts?: ReplacePluginOptions): void
	restart(id: PluginIdentifier, opts?: CascadeOptions): void
	commitDraft(meta: RuntimeUpdateCommitMeta): ReturnType<PluginService['commit']>
	completeTransaction(tx: RuntimeUpdateTransaction): void
	rollbackDraft(tx: RuntimeUpdateTransaction): void
	snapshotRuntimeModule(moduleId: string): RuntimeModuleSnapshot
	restoreRuntimeModule(moduleId: string, snapshot: RuntimeModuleSnapshot): void
	upsertRuntimeModule(module: RuntimeModuleDeclaration): void
	removeRuntimeModule(moduleId: string): void
}

type CommitExecutionPlan = {
	added: Set<RuntimePluginKey>
	replaced: PluginReplacement[]
	removed: Set<RuntimePluginKey>
	restartRequested: Set<RuntimePluginKey>
	toStop: Set<RuntimePluginKey>
	toStart: Set<RuntimePluginKey>
	toStopSlots: Set<number>
	toStartSlots: Set<number>
}

const EMPTY_DELTA = {
	added: [],
	removed: [],
	replaced: [],
	affected: [],
	retargetedTokens: [],
} as const

const normalizeRuntimeDependencyOverrides = (
	overrides: readonly (PluginIdentifier | undefined)[] | undefined,
): readonly (PluginIdentifier | undefined)[] | undefined => {
	if (!overrides || overrides.length === 0) return undefined
	let end = overrides.length
	while (end > 0 && overrides[end - 1] === undefined) end--
	if (end === 0) return undefined
	const next = Array<PluginIdentifier | undefined>(end)
	for (let i = 0; i < end; i++) next[i] = overrides[i]
	return next
}

const sameRuntimeDependencyOverrides = (
	left: readonly (PluginIdentifier | undefined)[] | undefined,
	right: readonly (PluginIdentifier | undefined)[] | undefined,
): boolean => {
	if (!left || left.length === 0) return !right || right.length === 0
	if (!right || right.length === 0) return false
	if (left.length !== right.length) return false
	for (let i = 0; i < left.length; i++) {
		if (left[i] !== right[i]) return false
	}
	return true
}

class PluginRuntimeUpdateTransaction implements RuntimeUpdateTransaction {
	public readonly reason: RuntimeUpdateReason
	private closed = false
	private readonly moduleSnapshots = new Map<string, RuntimeModuleSnapshot>()
	private readonly touchedModules = new Set<string>()

	public constructor(
		private readonly controller: RuntimeUpdateController,
		options: RuntimeUpdateOptions = {},
	) {
		this.reason = options.reason ?? 'startup'
	}

	public register(Plugin: PluginConstructor, opts?: { provideBase?: boolean }): void {
		this.assertOpen()
		this.controller.register(Plugin, opts)
	}

	public unregister(id: PluginIdentifier, opts?: CascadeOptions): void {
		this.assertOpen()
		this.controller.unregister(id, opts)
	}

	public replace(
		target: PluginIdentifier,
		next: PluginConstructor,
		opts?: ReplacePluginOptions,
	): void {
		this.assertOpen()
		this.controller.replace(target, next, opts)
	}

	public upsertModule(module: RuntimeModuleDeclaration): void {
		this.assertOpen()
		this.recordModuleSnapshot(module.moduleId)
		this.touchedModules.add(module.moduleId)
		this.controller.upsertRuntimeModule(module)
	}

	public removeModule(moduleId: string): void {
		this.assertOpen()
		this.recordModuleSnapshot(moduleId)
		this.touchedModules.add(moduleId)
		this.controller.removeRuntimeModule(moduleId)
	}

	public touchModule(moduleId: string): void {
		this.assertOpen()
		this.touchedModules.add(moduleId)
	}

	public touchModules(moduleIds: Iterable<string>): void {
		this.assertOpen()
		for (const moduleId of moduleIds) this.touchedModules.add(moduleId)
	}

	public restart(id: PluginIdentifier, opts?: CascadeOptions): void {
		this.assertOpen()
		this.controller.restart(id, opts)
	}

	public async commit(options: RuntimeUpdateCommitOptions = {}) {
		this.assertOpen()
		const rollbackOnFailure = options.rollbackOnFailure ?? true
		const result = await this.controller.commitDraft({
			reason: this.reason,
			touchedModules: [...this.touchedModules],
			autoDisabled: options.autoDisabled ?? [],
		})

		if (!result.ok) {
			if (rollbackOnFailure) {
				this.rollback()
			}
			return result
		}

		this.closed = true
		this.controller.completeTransaction(this)
		this.moduleSnapshots.clear()
		this.touchedModules.clear()

		const failed = options.strict ? (this.controller.lastCommitSummary()?.failed ?? []) : []
		if (failed.length > 0) {
			return createErr(new Error(`Some plugins failed to start: ${failed.map(String).join(', ')}`))
		}

		return result
	}

	public rollback(): void {
		if (this.closed) return
		this.closed = true
		this.rollbackModules()
		this.touchedModules.clear()
		this.controller.rollbackDraft(this)
	}

	private recordModuleSnapshot(moduleId: string): void {
		if (this.moduleSnapshots.has(moduleId)) return
		this.moduleSnapshots.set(moduleId, this.controller.snapshotRuntimeModule(moduleId))
	}

	private rollbackModules(): void {
		const entries = [...this.moduleSnapshots.entries()]
		for (let i = entries.length - 1; i >= 0; i--) {
			const [moduleId, items] = entries[i]!
			this.controller.restoreRuntimeModule(moduleId, items)
		}
		this.moduleSnapshots.clear()
	}

	private assertOpen(): void {
		if (this.closed) throw new Error('Runtime update transaction is already closed')
	}
}

export interface CommitSummary {
	graph: PluginGraph
	reason?: RuntimeUpdateReason
	added: RuntimePluginKey[]
	replaced: PluginReplacement[]
	removed: RuntimePluginKey[]
	failed: RuntimePluginKey[]
	touchedModules: string[]
	autoDisabled: RuntimePluginKey[]
	restarted: RuntimePluginKey[]
	/**
	 * Plugins whose runtime availability may have changed in this commit.
	 *
	 * This includes anything that was stopped or (re)started (adds, replaces, restarts, retries).
	 * Useful for efficient optional-dependency watchers (e.g. FeatureHost.dep).
	 */
	touched: RuntimePluginKey[]
}

type InstanceWatcher = {
	token: PluginIdentifier
	resolved: RuntimePluginKey | undefined
	lastRaw: BasePlugin | undefined
	lastNotifiedSeq: number
	cb: (instance: BasePlugin | undefined) => void
}

type DependentScratch = {
	marks: Uint8Array
	slots: number[]
	stack: number[]
}

class DependentClosureCollector {
	private scratch: DependentScratch = {
		marks: new Uint8Array(0),
		slots: [],
		stack: [],
	}

	public constructor(
		private readonly resolveGraphKey: (
			graph: PluginGraph | undefined,
			id: RuntimePluginHandle,
		) => RuntimePluginKey | undefined,
	) {}

	public collect(
		graph: PluginGraph | undefined,
		roots: Iterable<RuntimePluginHandle>,
	): Set<RuntimePluginKey> {
		if (!graph) {
			const out = new Set<RuntimePluginKey>()
			for (const root of roots) {
				const key = this.resolveGraphKey(undefined, root)
				if (key) out.add(key)
			}
			return out
		}

		if (this.scratch.marks.length < graph.slotCount()) {
			this.scratch = {
				marks: new Uint8Array(graph.slotCount()),
				slots: [],
				stack: [],
			}
		}

		const { marks, slots, stack } = this.scratch
		slots.length = 0
		stack.length = 0
		const affected = new Set<RuntimePluginKey>()
		for (const root of roots) {
			const canonical = this.resolveGraphKey(graph, root)
			if (!canonical) continue
			const slot = graph.slotOf(canonical)
			if (slot === undefined) {
				affected.add(canonical)
				continue
			}
			if (marks[slot] === 1) continue
			marks[slot] = 1
			slots.push(slot)
			stack.push(slot)
		}

		while (stack.length > 0) {
			const current = stack.pop()!
			const currentKey = graph.keyOf(current)
			if (currentKey !== undefined) affected.add(currentKey as RuntimePluginKey)
			const dependents = graph.dependentSlotsOf(current)
			for (let i = 0; i < dependents.length; i++) {
				const dep = dependents[i]!
				if (!Number.isInteger(dep) || dep < 0 || dep >= marks.length) continue
				if (marks[dep] === 1) continue
				marks[dep] = 1
				slots.push(dep)
				stack.push(dep)
			}
		}

		for (let i = 0; i < slots.length; i++) marks[slots[i]!] = 0
		slots.length = 0
		stack.length = 0
		return affected
	}
}

class InstanceWatcherRegistry {
	private readonly byResolved = new Map<RuntimePluginKey | undefined, Set<InstanceWatcher>>()
	private commitSeq = 0

	public constructor(
		private readonly resolveGraphKey: (
			graph: PluginGraph | undefined,
			id: PluginIdentifier,
		) => RuntimePluginKey | undefined,
		private readonly getRunningRuntimeInstance: (
			id: RuntimePluginKey | undefined,
		) => BasePlugin | undefined,
		private readonly logError: (error: unknown) => void,
	) {}

	public watch<T extends PluginIdentifier>(
		graph: PluginGraph | undefined,
		id: T,
		cb: (instance: InstanceType<T> | undefined) => void,
	): () => void {
		const resolved = this.resolveGraphKey(graph, id)
		const entry: InstanceWatcher = {
			token: id,
			resolved,
			lastRaw: this.getRunningRuntimeInstance(resolved),
			lastNotifiedSeq: this.commitSeq,
			cb: cb as unknown as (instance: BasePlugin | undefined) => void,
		}
		this.add(entry)

		try {
			entry.cb(entry.lastRaw as BasePlugin | undefined)
		} catch (error) {
			this.logError(error)
		}

		let active = true
		return () => {
			if (!active) return
			active = false
			this.remove(entry)
		}
	}

	public publish(summary: CommitSummary): void {
		if (this.byResolved.size === 0) return
		const touched = summary.touched
		if (touched.length === 0) return
		const seq = ++this.commitSeq
		const touchedSet = new Set(touched)

		for (let i = 0; i < touched.length; i++) {
			const set = this.byResolved.get(touched[i]!)
			if (!set || set.size === 0) continue
			this.flush(set, summary, seq)
		}

		const retargeted: InstanceWatcher[] = []
		for (const [resolved, set] of this.byResolved) {
			if (touchedSet.has(resolved)) continue
			for (const entry of set) {
				const nextResolved = this.resolveGraphKey(summary.graph, entry.token)
				if (nextResolved !== entry.resolved) retargeted.push(entry)
			}
		}
		for (let i = 0; i < retargeted.length; i++) this.notify(retargeted[i]!, summary, seq)
	}

	private flush(set: Set<InstanceWatcher>, summary: CommitSummary, seq: number): void {
		for (const entry of set) this.notify(entry, summary, seq)
	}

	private notify(entry: InstanceWatcher, summary: CommitSummary, seq: number): void {
		if (entry.lastNotifiedSeq === seq) return
		entry.lastNotifiedSeq = seq

		const nextResolved = this.resolveGraphKey(summary.graph, entry.token)
		if (nextResolved !== entry.resolved) {
			this.remove(entry)
			entry.resolved = nextResolved
			this.add(entry)
		}

		const raw = this.getRunningRuntimeInstance(entry.resolved)
		if (raw === entry.lastRaw) return
		entry.lastRaw = raw
		try {
			entry.cb(raw)
		} catch (error) {
			this.logError(error)
		}
	}

	private add(entry: InstanceWatcher): void {
		let set = this.byResolved.get(entry.resolved)
		if (!set) {
			set = new Set()
			this.byResolved.set(entry.resolved, set)
		}
		set.add(entry)
	}

	private remove(entry: InstanceWatcher): void {
		const set = this.byResolved.get(entry.resolved)
		set?.delete(entry)
		if (set && set.size === 0) this.byResolved.delete(entry.resolved)
	}
}

/* ─────────────────────────── Module Augmentation ─────────────────────────── */

const serviceName = 'registry' as const
declare module '@pluxel/context' {
	// oxlint-disable-next-line eslint/no-unused-vars -- declaration merging target namespace
	namespace Context {
		// oxlint-disable-next-line eslint/no-unused-vars -- declaration merging target interface
		interface Config {
			[serviceName]?: PluginServiceConfig
		}
	}
	export interface Context {
		pluginInfo: PluginInfo
		parent?: Context
		caller?: Context
	}
	export namespace Context {
		// oxlint-disable-next-line eslint/no-unused-vars -- declaration merging target interface
		interface Services {
			[serviceName]: PluginService
		}
	}
}

/* ─────────────────────────── Service ─────────────────────────── */

@Injectable({ key: serviceName })
export class PluginService {
	private readonly definitions: PluginDefinitions

	private _commitLock: Promise<unknown> = Promise.resolve()
	private readonly startTimeoutMs: number
	private readonly stopTimeoutMs: number
	private readonly startStrategy: PluginStartStrategy
	private readonly startConcurrency: number
	private readonly stopConcurrency: number
	private _lastCommit?: CommitSummary
	/** Active draft graph during commit() before confirm(). */
	private _activeGraph?: PluginGraph
	private _activeRuntime?: PluginRuntime
	/** Plugins that should be (re)started on the next commit. */
	private _pendingStart = new Set<RuntimePluginKey>()
	/** Plugins that should be restarted (re-instantiated) on the next commit. */
	private _pendingRestart = new Set<RuntimePluginKey>()
	private activeRuntimeUpdate?: RuntimeUpdateTransaction
	private readonly runtimeUpdateCheckpoints = new WeakMap<
		RuntimeUpdateTransaction,
		RuntimeUpdateCheckpoint
	>()
	private readonly runtimeModuleItems = new Map<string, readonly RuntimeModuleDeclarationItem[]>()
	private readonly runtimeModuleRevisions = new Map<string, number>()
	private readonly runtimeModuleByName = new Map<string, string>()
	private readonly runtimeModuleCtorByName = new Map<string, PluginConstructor>()
	private readonly runtimeModuleByCtor = new WeakMap<PluginConstructor, string>()
	private runtimeModuleRevision = 0
	private readonly runtimeDependencyOverrides = new Map<
		string,
		readonly (PluginIdentifier | undefined)[]
	>()
	private readonly runtimeKeysByCtor = new WeakMap<PluginConstructor, RuntimePluginKey>()
	private order = 0
	private readonly featureDeclarationPolicyDefault: 'off' | 'warn' | 'error'
	private readonly featureDeclarationPolicyExplicit: boolean
	private nextCommitFeatureDeclarationPolicy: 'off' | 'warn' | 'error' | null = null
	private readonly watcherRegistry: InstanceWatcherRegistry
	private readonly dependentClosure: DependentClosureCollector
	private readonly runtimeUpdateController: RuntimeUpdateController = {
		lastCommitSummary: () => this.lastCommit,
		register: (Plugin, opts) => this.register(Plugin, opts),
		unregister: (id, opts) => this.unregister(id, opts),
		replace: (target, next, opts) => this.replace(target, next, opts),
		restart: (id, opts) => this.restart(id, opts),
		commitDraft: (meta) => this.commitRuntimeUpdate(meta),
		completeTransaction: (tx) => this.clearRuntimeUpdateCheckpoint(tx),
		rollbackDraft: (tx) => this.rollbackRuntimeUpdate(tx),
		snapshotRuntimeModule: (moduleId) => this.snapshotRuntimeModule(moduleId),
		restoreRuntimeModule: (moduleId, snapshot) => this.restoreRuntimeModule(moduleId, snapshot),
		upsertRuntimeModule: (module) => this.upsertRuntimeModule(module),
		removeRuntimeModule: (moduleId) => this.removeRuntimeModule(moduleId),
	}

	private static readonly FEATURE_DECLARATION_POLICY = Symbol.for(
		'pluxel:feature:declarationPolicy',
	)

	// Internal helpers (single instances; no per‑commit allocations).
	private readonly lifecycle: LifecycleManager

	constructor(
		public ctx: PluxelContext,
		config: PluginServiceConfig,
	) {
		this.startTimeoutMs = config?.startTimeoutMs ?? 1_500
		this.stopTimeoutMs = config?.stopTimeoutMs ?? 3_000
		this.startStrategy = config?.startStrategy ?? 'ready-queue'
		this.startConcurrency = config?.startConcurrency ?? 8
		this.stopConcurrency = config?.stopConcurrency ?? 1
		this.featureDeclarationPolicyExplicit =
			config?.featureDeclarationPolicy !== null && config?.featureDeclarationPolicy !== undefined
		this.featureDeclarationPolicyDefault =
			config?.featureDeclarationPolicy ?? (isProduction ? 'off' : 'warn')

		const isolated: AnyServiceClass[] = []
		const seen = new Set<AnyServiceClass>()
		for (const svc of config?.pluginCTXIsolate ?? []) {
			const s = svc as unknown as AnyServiceClass
			if (seen.has(s)) continue
			seen.add(s)
			isolated.push(s)
		}
		const effectsSvc = EffectsService as unknown as AnyServiceClass
		if (!seen.has(effectsSvc)) {
			seen.add(effectsSvc)
			isolated.push(effectsSvc)
		}
		this.definitions = new PluginDefinitions(
			() => {
				const pluginCTX = this.ctx.root.isolate(isolated, { name: `${this.order++}` })
				const override = this.nextCommitFeatureDeclarationPolicy
				if (
					this.featureDeclarationPolicyExplicit ||
					(override !== null && override !== undefined)
				) {
					const policy = override ?? this.featureDeclarationPolicyDefault
					Object.defineProperty(pluginCTX, PluginService.FEATURE_DECLARATION_POLICY, {
						value: policy,
						writable: false,
						enumerable: false,
						configurable: true,
					})
				}

				// Effects are per‑plugin by design and used heavily for lifecycle cleanups.
				// Pin the instance to:
				// 1) avoid Context service‑getter overhead on hot paths;
				// 2) keep identity stable for this plugin context.
				try {
					const effects = pluginCTX.effects
					if (effects) {
						Object.defineProperty(pluginCTX, 'effects', {
							value: effects,
							writable: false,
							enumerable: false,
							configurable: true,
						})
					}
				} catch {
					// If effects service was overridden/removed, fall back silently.
				}

				return pluginCTX
			},
			{
				resolveDependencyToken: (token) => this.resolveRuntimeModuleDependencyToken(token),
				resolveDependencyTokenOverrides: (pluginId) =>
					this.runtimeDependencyOverrides.get(pluginId),
			},
		)

		this.lifecycle = new LifecycleManager(this.ctx, this.startTimeoutMs, this.stopTimeoutMs)
		this.dependentClosure = new DependentClosureCollector((graph, id) =>
			this.resolveGraphKey(graph, id),
		)
		this.watcherRegistry = new InstanceWatcherRegistry(
			(graph, id) => this.resolveRuntimeReadKey(graph, id),
			(id) => this.getRunningRuntimeInstance(id),
			(error) => {
				this.ctx.logger.error('instance watcher error', { error })
			},
		)
	}

	private async injectConfig(plugin: PluginInstance): Promise<void> {
		const pluginCtx = plugin.ctx
		const info: PluginInfo = pluginCtx.pluginInfo
		// Fast path: toolchain injection (configSourcePlugin) produced a configMap/bindings at decoration time.
		const schemaMap = info.configMap ?? undefined
		const bindings = info.configBindingsMap ?? undefined
		if (!schemaMap) return

		const id = info.id

		// Validate + fill defaults before injection (HMR already does this in the loader).
		// Surface any error as a start failure; plugins should not start with invalid config.
		await pluginCtx.configService.ensureValidated(id, schemaMap, { missingObjectDefault: {} })

		// Only inject instance fields when the plugin declared bindings.
		// Some plugins only declare schemas via composed features and don't have any config fields themselves,
		// but still need validation so features can read from the validated snapshot.
		if (bindings && Object.keys(bindings).length > 0) {
			const record = pluginCtx.configService.getValidatedConfig(id)
			const pluginObj = plugin as unknown as Record<string, unknown>
			const recordObj = record as unknown as Record<string, unknown>

			for (const field of Object.keys(bindings)) {
				const keys = bindings[field] ?? []
				if (!Array.isArray(keys) || keys.length === 0) {
					pluginObj[field] = Object.create(null)
					continue
				}
				if (keys.length === 1) {
					pluginObj[field] = recordObj[keys[0] as string]
					continue
				}
				const view: Record<string, unknown> = Object.create(null)
				for (let i = 0; i < keys.length; i++) {
					const k = keys[i] as string
					view[k] = recordObj[k]
				}
				pluginObj[field] = view
			}
		}

		// Feature instances may be constructed during plugin field initialization (before config injection).
		// After validation + plugin injection, re-run feature config injection so feature fields are updated
		// from the validated snapshot (never from raw).
		try {
			const host = plugin.features as unknown as { __injectConfigsFromHostPlugin?: () => void }
			host.__injectConfigsFromHostPlugin?.()
		} catch (error) {
			const logger = pluginCtx.logger ?? this.ctx.logger
			logger.error('feature config inject error', { error })
		}
	}

	private resolveGraphKey(
		graph: PluginGraph | undefined,
		id: RuntimePluginHandle,
	): RuntimePluginKey | undefined {
		if (typeof id === 'string') {
			if (!graph || graph.has(id)) return id as RuntimePluginKey
			const resolved = graph.resolve(id)
			return typeof resolved === 'string' ? (resolved as RuntimePluginKey) : (id as RuntimePluginKey)
		}
		try {
			const key = this.runtimeKeyOfCtor(id)
			if (!graph || graph.has(key)) return key
		} catch {
			// Base/abstract tokens may be undecorated; fall back to graph aliases.
		}
		const resolved = graph?.resolve(id)
		if (typeof resolved === 'string') return resolved as RuntimePluginKey
		return undefined
	}

	private resolveRuntimeReadKey(
		graph: PluginGraph | undefined,
		id: PluginIdentifier,
	): RuntimePluginKey | undefined {
		const resolved = this.resolveGraphKey(graph, id)
		if (resolved && graph?.has(resolved)) return resolved
		const owner = this.resolveRuntimeModuleDependencyToken(id)
		if (!owner || owner === resolved) return resolved
		return this.resolveGraphKey(graph, owner)
	}

	private resolveRuntimeModuleDependencyToken(
		token: PluginIdentifier,
	): RuntimePluginKey | undefined {
		if (typeof token !== 'function') return undefined
		let id: string
		try {
			id = getPluginInfo(token as PluginConstructor).id
		} catch {
			return undefined
		}

		const exact = this.runtimeModuleCtorByName.get(id)
		if (exact) return this.runtimeKeyOfCtor(exact)

		const fork = parseForkPluginId(id)
		if (fork) {
			const baseCtor = this.runtimeModuleCtorByName.get(fork.baseId)
			if (!baseCtor) return this.runtimeKeyOfCtor(token)
			const existing = getForkedCtor(baseCtor, fork.forkId)
			if (existing) return this.runtimeKeyOfCtor(existing)
			try {
				forkPlugin(baseCtor as ForkablePluginConstructor, fork.forkId)
				return formatForkPluginId(fork.baseId, fork.forkId) as RuntimePluginKey
			} catch {
				return undefined
			}
		}

		return runtimePluginKeyOfName(id)
	}

	private activeRuntime(): PluginRuntime {
		return this._activeRuntime ?? this.definitions.runtime
	}

	private runtimeKeyOfCtor(ctor: PluginIdentifier): RuntimePluginKey {
		const keyCtor = ctor as PluginConstructor
		const cached = this.runtimeKeysByCtor.get(keyCtor)
		if (cached) return cached
		const key = runtimePluginKeyOfCtor(ctor)
		this.runtimeKeysByCtor.set(keyCtor, key)
		return key
	}

	private hasDraftStructuralChanges(): boolean {
		return this._activeGraph !== undefined || this.definitions.hasPendingChanges()
	}

	private resolvePlanningKey(id: RuntimePluginHandle): RuntimePluginKey | undefined {
		if (!this.hasDraftStructuralChanges()) return this.resolveGraphKey(this.graph, id)
		return this._activeGraph
			? this.resolveGraphKey(this._activeGraph, id)
			: (this.definitions.resolvePlanningHandle(id) ?? this.resolveGraphKey(undefined, id))
	}

	private planningContains(id: RuntimePluginHandle): boolean {
		if (!this.hasDraftStructuralChanges()) {
			const graph = this.graph
			const key = this.resolveGraphKey(graph, id)
			return (
				(key !== undefined && graph.has(key)) ||
				(typeof id !== 'string' && graph.resolve(id) !== undefined)
			)
		}
		if (this._activeGraph) {
			const key = this.resolveGraphKey(this._activeGraph, id)
			return (
				(key !== undefined && this._activeGraph.has(key)) ||
				(typeof id !== 'string' && this._activeGraph.resolve(id) !== undefined)
			)
		}
		return this.definitions.resolvePlanningHandle(id) !== undefined
	}

	private collectPlanningCascadeTargets(
		id: RuntimePluginHandle,
		cascadeDependents = true,
	): Set<RuntimePluginKey> {
		if (!cascadeDependents) {
			const key = this.resolvePlanningKey(id)
			return key ? new Set([key]) : new Set()
		}
		if (!this.hasDraftStructuralChanges()) {
			const graph = this.graph
			const key = this.resolveGraphKey(graph, id)
			if (key) {
				const slot = graph.slotOf(key)
				if (slot !== undefined && graph.dependentSlotsOf(slot).length === 0) {
					return new Set([key])
				}
			}
			return this.dependentClosure.collect(graph, [id])
		}
		if (this._activeGraph) return this.dependentClosure.collect(this._activeGraph, [id])
		return this.definitions.collectPlanningCascadeTargets(id)
	}

	private clearPendingOperations(ids: Iterable<RuntimePluginKey>): void {
		for (const id of ids) {
			this._pendingStart.delete(id)
			this._pendingRestart.delete(id)
		}
	}

	private collectRuntimeEvictions(plan: CommitExecutionPlan): Set<RuntimePluginKey> {
		const evict = new Set<RuntimePluginKey>(plan.toStop)
		for (let i = 0; i < plan.replaced.length; i++) {
			evict.add(plan.replaced[i]!.from)
		}
		for (const id of plan.toStart) {
			if (!plan.toStop.has(id)) evict.add(id)
		}
		return evict
	}

	/* ─────────────────────────── State Query ─────────────────────────── */

	isRunning(id: PluginIdentifier): boolean {
		const graph = this._activeGraph ?? this.graph
		const key = this.resolveRuntimeReadKey(graph, id)
		if (!key) return false
		const instance = this.getRuntimeInstance(key)
		return this.lifecycle.isRunning(instance)
	}

	/** Whether an identifier is registered in the current draft container. */
	isRegistered(id: PluginIdentifier): boolean {
		return this.definitions.isRegistered(id)
	}

	public get lastCommit(): CommitSummary | undefined {
		return this._lastCommit
	}

	public listRuntimeModuleItems(moduleId: string): readonly RuntimeModuleDeclarationItem[] {
		return this.runtimeModuleItems.get(moduleId) ?? []
	}

	public replaceRuntimeDependencyOverrides(
		plugin: PluginIdentifier | string,
		overrides: readonly (PluginIdentifier | undefined)[] | undefined,
	): void {
		const pluginId =
			typeof plugin === 'string' ? plugin : getPluginInfo(plugin as PluginConstructor).id
		const next = normalizeRuntimeDependencyOverrides(overrides)
		const prev = this.runtimeDependencyOverrides.get(pluginId)
		if (sameRuntimeDependencyOverrides(prev, next)) return

		this.recordRuntimeDependencyOverrideSnapshot(pluginId)

		if (!next) {
			this.runtimeDependencyOverrides.delete(pluginId)
		} else {
			this.runtimeDependencyOverrides.set(pluginId, next)
		}

		const current =
			typeof plugin === 'function'
				? (plugin as PluginConstructor)
				: this.runtimeModuleCtorByName.get(pluginId)
		if (!current || !this.planningContains(current)) {
			return
		}

		const canonical = this.resolvePlanningKey(current)
		if (!canonical) return
		const provideBase = this.resolveCurrentProvideBase(current, canonical)
		this.definitions.replace(canonical, current, {
			provideBase,
		})
		this._pendingRestart.add(canonical)
	}

	private resolveCurrentProvideBase(
		ctor: PluginConstructor,
		canonical: RuntimePluginKey,
	): boolean | undefined {
		let base: PluginIdentifier | undefined
		try {
			base = getPluginInfo(ctor).base as PluginIdentifier | undefined
		} catch {
			return undefined
		}
		if (!base) return undefined

		const graph = this._activeGraph ?? this.graph
		const declaration = graph.declaration(canonical)
		if (!declaration) return undefined
		return declaration.tokens.includes(base)
	}

	public getRuntimeModuleId(id: PluginIdentifier | string): string | undefined {
		if (typeof id === 'string') return this.getRuntimeModuleIdByKey(id)
		const graph = this._activeGraph ?? this.graph
		const resolved = this.resolveGraphKey(graph, id)
		if (resolved) {
			const byResolved = this.getRuntimeModuleIdByKey(resolved)
			if (byResolved) return byResolved
		}
		if (typeof id === 'function') {
			const direct = this.runtimeModuleByCtor.get(id as PluginConstructor)
			if (direct) return direct
		}
		try {
			const info = getPluginInfo(id as PluginConstructor)
			return this.getRuntimeModuleIdByKey(info.id)
		} catch {
			return undefined
		}
	}

	/**
	 * Resolve a public plugin handle to the committed runtime graph key.
	 *
	 * Constructor handles are compatibility/read-model inputs; they are not stored
	 * as graph tokens unless they are abstract/base aliases.
	 */
	public resolveRuntimeKey(id: PluginIdentifier | string): RuntimePluginKey | undefined {
		const graph = this._activeGraph ?? this.graph
		const key = this.resolveRuntimeReadKey(graph, id as PluginIdentifier)
		return key && graph.has(key) ? key : undefined
	}

	private getRuntimeModuleIdByKey(key: string): string | undefined {
		const direct = this.runtimeModuleByName.get(key)
		if (direct) return direct
		const fork = parseForkPluginId(key)
		return fork ? this.runtimeModuleByName.get(fork.baseId) : undefined
	}

	/**
	 * Get the current singleton instance for an identifier if it is running.
	 * This does not instantiate or start anything; it only reads the runtime cache + running state.
	 */
	public getInstance<T extends PluginIdentifier>(id: T): InstanceType<T> | undefined {
		const graph = this._activeGraph ?? this.graph
		const key = this.resolveRuntimeReadKey(graph, id)
		if (!key) return undefined
		return this.getRunningRuntimeInstance(key) as InstanceType<T> | undefined
	}

	/**
	 * Watch the runtime instance behind a plugin identifier.
	 *
	 * - The callback is invoked immediately with the current *running* instance (or `undefined`).
	 * - On commits, it is only re-evaluated when the *resolved* target is touched (start/stop/restart/replace).
	 * - If identifier resolution changes across commits (aliases/replacements), the watcher auto-rebinds.
	 */
	public watchInstance<T extends PluginIdentifier>(
		id: T,
		cb: (instance: InstanceType<T> | undefined) => void,
	): () => void {
		return this.watcherRegistry.watch(this._activeGraph ?? this.graph, id, cb)
	}

	/* ─────────────────────────── Forks ─────────────────────────── */

	/**
	 * Create (or reuse) a fork ctor for a ForkablePlugin.
	 * This does not register it into the container.
	 */
	public fork<T extends ForkablePluginConstructor>(ctor: T, forkId: string): PluginConstructor {
		return forkPlugin(ctor, forkId)
	}

	/**
	 * Convenience: fork + register into the current draft container.
	 * The fork will be started on the next commit().
	 */
	public registerFork<T extends ForkablePluginConstructor>(
		ctor: T,
		forkId: string,
		opts?: { provideBase?: boolean },
	): PluginConstructor {
		const ForkCtor = forkPlugin(ctor, forkId)
		this.register(ForkCtor, opts)
		return ForkCtor
	}

	/** Get a running fork instance if present; otherwise undefined. */
	public getFork<T extends PluginIdentifier>(ctor: T, forkId: string): InstanceType<T> | undefined {
		const ForkCtor = getForkedCtor(ctor, forkId)
		if (!ForkCtor) return undefined
		return this.getRunningRuntimeInstance(this.runtimeKeyOfCtor(ForkCtor)) as
			| InstanceType<T>
			| undefined
	}

	/** List all fork ctors created for a given original ctor. */
	public listForks<T extends PluginIdentifier>(ctor: T): PluginConstructor[] {
		return listForks(ctor)
	}

	/* ─────────────────────────── Declaration Layer ─────────────────────────── */

	/** Last committed DI graph. */
	public get graph(): PluginGraph {
		return this.definitions.lastGraph
	}

	/** Roll back draft registrations since last confirmed container. */
	public resetDraft(): void {
		this.definitions.resetDraft()
	}

	/**
	 * Start a bounded runtime declaration update.
	 *
	 * This is intentionally a top-level transaction: PluginDefinitions currently only supports
	 * rollback to the last confirmed graph, so nested updates or updates opened on top of existing
	 * draft mutations would make rollback semantics ambiguous.
	 */
	public beginUpdate(options: RuntimeUpdateOptions = {}): RuntimeUpdateTransaction {
		if (this.activeRuntimeUpdate) {
			throw new Error('Cannot begin runtime update while another runtime update is active')
		}
		if (this.definitions.hasPendingChanges()) {
			throw new Error('Cannot begin runtime update while registry draft has pending changes')
		}
		const tx = new PluginRuntimeUpdateTransaction(this.runtimeUpdateController, options)
		this.runtimeUpdateCheckpoints.set(tx, this.createRuntimeUpdateCheckpoint())
		this.activeRuntimeUpdate = tx
		return tx
	}

	private clearRuntimeUpdateCheckpoint(tx: RuntimeUpdateTransaction): void {
		this.runtimeUpdateCheckpoints.delete(tx)
		if (this.activeRuntimeUpdate === tx) this.activeRuntimeUpdate = undefined
	}

	private rollbackRuntimeUpdate(tx: RuntimeUpdateTransaction): void {
		const checkpoint = this.runtimeUpdateCheckpoints.get(tx)
		this.runtimeUpdateCheckpoints.delete(tx)
		if (this.activeRuntimeUpdate === tx) this.activeRuntimeUpdate = undefined
		this.definitions.resetDraft()
		if (checkpoint) {
			this.restoreRuntimeDependencyOverrides(checkpoint.dependencyOverrides)
			this._pendingStart = new Set(checkpoint.pendingStart)
			this._pendingRestart = new Set(checkpoint.pendingRestart)
		}
	}

	private createRuntimeUpdateCheckpoint(): RuntimeUpdateCheckpoint {
		return {
			pendingStart: new Set(this._pendingStart),
			pendingRestart: new Set(this._pendingRestart),
			dependencyOverrides: new Map(),
		}
	}

	private recordRuntimeDependencyOverrideSnapshot(pluginId: string): void {
		const tx = this.activeRuntimeUpdate
		if (!tx) return
		const checkpoint = this.runtimeUpdateCheckpoints.get(tx)
		if (!checkpoint || checkpoint.dependencyOverrides.has(pluginId)) return
		checkpoint.dependencyOverrides.set(pluginId, this.runtimeDependencyOverrides.get(pluginId))
	}

	private restoreRuntimeDependencyOverrides(
		snapshots: ReadonlyMap<string, readonly (PluginIdentifier | undefined)[] | undefined>,
	): void {
		for (const [pluginId, prev] of snapshots) {
			if (!prev) this.runtimeDependencyOverrides.delete(pluginId)
			else this.runtimeDependencyOverrides.set(pluginId, prev)
		}
	}

	public upsertRuntimeModule(module: RuntimeModuleDeclaration): void {
		this.setRuntimeModule(module, ++this.runtimeModuleRevision)
	}

	private setRuntimeModule(module: RuntimeModuleDeclaration, revision: number): void {
		const moduleId = module.moduleId
		this.removeRuntimeModuleIndex(moduleId)
		const items = module.items
			.map((item) => ({ ctor: item.ctor, exportKey: item.exportKey }))
			.filter((item) => typeof item.ctor === 'function')
		if (items.length === 0) {
			this.runtimeModuleItems.delete(moduleId)
			this.runtimeModuleRevisions.delete(moduleId)
			return
		}
		this.runtimeModuleItems.set(moduleId, items)
		this.runtimeModuleRevisions.set(moduleId, revision)
		if (revision > this.runtimeModuleRevision) this.runtimeModuleRevision = revision
		for (let i = 0; i < items.length; i++) {
			const { ctor } = items[i]!
			if (this.shouldClaimRuntimeModuleCtor(ctor, moduleId, revision)) {
				this.runtimeModuleByCtor.set(ctor, moduleId)
			}
			try {
				const info = getPluginInfo(ctor)
				if (this.shouldClaimRuntimeModuleName(info.id, moduleId, revision)) {
					this.runtimeModuleByName.set(info.id, moduleId)
					this.runtimeModuleCtorByName.set(info.id, ctor)
				}
			} catch {
				// Keep module ownership best-effort; invalid plugin ctors still fail at registration.
			}
		}
	}

	public removeRuntimeModule(moduleId: string): void {
		this.removeRuntimeModuleIndex(moduleId)
		this.runtimeModuleItems.delete(moduleId)
		this.runtimeModuleRevisions.delete(moduleId)
	}

	private snapshotRuntimeModule(moduleId: string): RuntimeModuleSnapshot {
		const items = this.runtimeModuleItems.get(moduleId)
		if (!items) return undefined
		return {
			items: [...items],
			revision: this.runtimeModuleRevisions.get(moduleId) ?? 0,
		}
	}

	private restoreRuntimeModule(moduleId: string, snapshot: RuntimeModuleSnapshot): void {
		if (!snapshot) {
			this.removeRuntimeModule(moduleId)
			return
		}
		this.setRuntimeModule({ moduleId, items: snapshot.items }, snapshot.revision)
	}

	private shouldClaimRuntimeModuleName(name: string, moduleId: string, revision: number): boolean {
		const currentModuleId = this.runtimeModuleByName.get(name)
		if (!currentModuleId || currentModuleId === moduleId) return true
		return (this.runtimeModuleRevisions.get(currentModuleId) ?? 0) <= revision
	}

	private shouldClaimRuntimeModuleCtor(
		ctor: PluginConstructor,
		moduleId: string,
		revision: number,
	): boolean {
		const currentModuleId = this.runtimeModuleByCtor.get(ctor)
		if (!currentModuleId || currentModuleId === moduleId) return true
		return (this.runtimeModuleRevisions.get(currentModuleId) ?? 0) <= revision
	}

	private removeRuntimeModuleIndex(moduleId: string): void {
		const prev = this.runtimeModuleItems.get(moduleId)
		if (!prev) return
		for (let i = 0; i < prev.length; i++) {
			const ctor = prev[i]!.ctor
			try {
				const info = getPluginInfo(ctor)
				const ownedByModule = this.runtimeModuleByName.get(info.id) === moduleId
				if (ownedByModule) {
					this.runtimeModuleByName.delete(info.id)
				}
				if (ownedByModule && this.runtimeModuleCtorByName.get(info.id) === ctor) {
					this.runtimeModuleCtorByName.delete(info.id)
				}
				if (ownedByModule) this.restoreRuntimeModuleNameIndex(info.id, moduleId)
			} catch {
				// ignore invalid decorator state in stale declarations
			}
		}
		// WeakMap entries cannot be deleted without a ctor key scan from the old module list.
		for (let i = 0; i < prev.length; i++) {
			const ctor = prev[i]!.ctor
			if (this.runtimeModuleByCtor.get(ctor) === moduleId) {
				this.runtimeModuleByCtor.delete(ctor)
				this.restoreRuntimeModuleCtorIndex(ctor, moduleId)
			}
		}
	}

	private restoreRuntimeModuleNameIndex(name: string, skipModuleId: string): void {
		let best:
			| {
					moduleId: string
					ctor: PluginConstructor
					revision: number
			  }
			| undefined
		for (const [moduleId, items] of this.runtimeModuleItems) {
			if (moduleId === skipModuleId) continue
			const revision = this.runtimeModuleRevisions.get(moduleId) ?? 0
			for (let i = 0; i < items.length; i++) {
				const ctor = items[i]!.ctor
				try {
					if (getPluginInfo(ctor).id !== name) continue
					if (!best || revision >= best.revision) {
						best = { moduleId, ctor, revision }
					}
				} catch {
					// ignore invalid decorator state in stale declarations
				}
			}
		}
		if (!best) return
		this.runtimeModuleByName.set(name, best.moduleId)
		this.runtimeModuleCtorByName.set(name, best.ctor)
	}

	private restoreRuntimeModuleCtorIndex(ctor: PluginConstructor, skipModuleId: string): void {
		let best:
			| {
					moduleId: string
					revision: number
			  }
			| undefined
		for (const [moduleId, items] of this.runtimeModuleItems) {
			if (moduleId === skipModuleId) continue
			const revision = this.runtimeModuleRevisions.get(moduleId) ?? 0
			for (let i = 0; i < items.length; i++) {
				if (items[i]!.ctor !== ctor) continue
				if (!best || revision >= best.revision) {
					best = { moduleId, revision }
				}
			}
		}
		if (best) this.runtimeModuleByCtor.set(ctor, best.moduleId)
	}

	/** Register a plugin ctor into the draft container. */
	public register(Plugin: PluginConstructor, opts?: { provideBase?: boolean }): void {
		this.definitions.register(Plugin, opts)
	}

	/**
	 * Unregister a plugin from the declaration layer.
	 * Default behavior cascades to dependents to keep DI verification valid.
	 */
	public unregister(id: PluginIdentifier, opts?: CascadeOptions): void {
		const canonical = this.resolvePlanningKey(id)
		if (!canonical) return
		const targets = this.collectPlanningCascadeTargets(canonical, opts?.cascadeDependents ?? true)
		for (const t of targets) this.definitions.unregister(t)
		this.clearPendingOperations(targets)
		this._pendingStart.delete(canonical)
		this._pendingRestart.delete(canonical)
	}

	/**
	 * Shutdown (unload) the current plugin (and optionally its dependents) from within a plugin context.
	 *
	 * This is an orchestration-layer operation and intentionally lives on PluginService (registry),
	 * not on `effects`.
	 */
	public shutdownSelf(opts?: CascadeOptions) {
		const pluginInfo = (this.ctx as unknown as { pluginInfo?: { class?: unknown } }).pluginInfo
		if (!pluginInfo?.class) {
			throw new Error('Cannot shutdown: not in a plugin context')
		}
		this.unregister(pluginInfo.class as PluginIdentifier, opts)
		return this.commit()
	}

	/**
	 * Restart a registered plugin (and optionally its dependents) on next commit.
	 * This does not change registrations; it only re-instantiates instances.
	 */
	public restart(id: PluginIdentifier, opts?: CascadeOptions): void {
		if (!this.planningContains(id)) {
			throw new Error(`You can not restart an unloaded Plugin: ${String(id)}`)
		}
		const canonical = this.resolvePlanningKey(id)
		if (!canonical) {
			throw new Error(`You can not restart an unloaded Plugin: ${String(id)}`)
		}
		const targets = this.collectPlanningCascadeTargets(canonical, opts?.cascadeDependents ?? true)
		for (const t of targets) {
			const key = t
			if (!this.planningContains(key)) {
				throw new Error(`You can not restart an unloaded Plugin: ${String(t)}`)
			}
			this._pendingRestart.add(key)
		}
	}

	/**
	 * Replace a plugin implementation (HMR) and restart the affected subtree on next commit.
	 */
	public replace(
		target: PluginIdentifier,
		next: PluginConstructor,
		opts?: ReplacePluginOptions,
	): void {
		const canonical = this.resolvePlanningKey(target)
		if (!canonical) {
			throw new Error(`You can not replace an unloaded Plugin: ${String(target)}`)
		}
		const targets = this.collectPlanningCascadeTargets(canonical, opts?.cascadeDependents ?? true)

		this.definitions.replace(canonical, next, {
			provideBase: opts?.provideBase,
			aliases: [canonical],
		})

		// Runtime intent: restart affected plugins so they observe the new provider instance.
		for (const t of targets) this._pendingRestart.add(t)
	}

	/* ─────────────────────────── Commit Internals ─────────────────────────── */

	private enqueueCommit(
		policyOverride: 'off' | 'warn' | 'error' | null,
		meta: RuntimeUpdateCommitMeta | null = null,
	) {
		const next = this._commitLock
			.then(async () => {
				const prev = this.nextCommitFeatureDeclarationPolicy
				this.nextCommitFeatureDeclarationPolicy = policyOverride
				try {
					return await this.executeCommit(meta)
				} finally {
					this.nextCommitFeatureDeclarationPolicy = prev
				}
			})
			.catch((error) => {
				void this.ctx.logger.with({ error }).error`commit 内部异常`
				return createErr(error)
			})

		this._commitLock = next
		return next
	}

	private async stopPlugin(id: RuntimePluginKey): Promise<void> {
		// Important: don't call container.get() here; it may instantiate plugins just to stop them.
		// Only stop plugins that were actually constructed (and thus may be running).
		const plugin = this.getRuntimeInstance(id)
		if (!plugin) return
		await this.lifecycle.stopLifecycle(id, plugin, { timeoutMs: this.resolveStopTimeoutMs(plugin) })
	}

	private resolveStartTimeoutMs(plugin: BasePlugin): number | undefined {
		const info = plugin.ctx.pluginInfo
		return readFinitePositiveMsFromMeta(info.metadata, 'startTimeoutMs')
	}

	private resolveStopTimeoutMs(plugin: BasePlugin): number | undefined {
		const info = plugin.ctx.pluginInfo
		return readFinitePositiveMsFromMeta(info.metadata, 'stopTimeoutMs')
	}

	private getRuntimeInstance(id: RuntimePluginKey | undefined): BasePlugin | undefined {
		if (!id) return undefined
		return this.activeRuntime().peekByKey(id) as BasePlugin | undefined
	}

	private getRunningRuntimeInstance(id: RuntimePluginKey | undefined): BasePlugin | undefined {
		const instance = this.getRuntimeInstance(id)
		return instance && this.lifecycle.isRunning(instance) ? instance : undefined
	}

	private async applyTeardown(graph: PluginGraph | undefined, toStop: Set<number>): Promise<void> {
		if (!graph || toStop.size === 0) return
		// Default concurrency is 1 (sequential) to preserve legacy stop behavior.
		await stopPluginsTopo(
			(slot) => graph.dependentSlotsOf(slot),
			toStop,
			async (slot) => {
				const id = graph.keyOf(slot)
				if (id !== undefined) await this.stopPlugin(id as RuntimePluginKey)
			},
			{ concurrency: this.stopConcurrency },
		)
	}

	private async instantiateAndStart(
		runtime: PluginRuntime,
		id: RuntimePluginKey,
	): Promise<boolean> {
		let instance: PluginInstance
		try {
			instance = runtime.ensureByKey(id) as PluginInstance
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error), { cause: error })
			try {
				this.ctx.emit('resolveError', id, err)
			} catch {
				// ignore: events service may be overridden
			}
			void this.ctx.logger.with({ error: err }).error`解析 ${String(id)} 失败`
			return false
		}
		const pluginCtx = instance.ctx

		// Core responsibility: inject declared config fields before plugin init().
		// Doing it directly avoids an extra event hop on every plugin start.
		try {
			await this.injectConfig(instance)
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error), { cause: error })
			try {
				// Treat config injection/validation failures as start errors so callers can observe the root cause.
				this.ctx.emit('startError', pluginCtx, err)
			} catch {
				// ignore: events service may be overridden
			}
			const logger = pluginCtx.logger ?? this.ctx.logger
			void logger.with({ error: err }).error`注入/校验配置到 ${String(id)} 失败`
			try {
				await pluginCtx.effects.dispose()
			} catch {
				/* ignored */
			}
			return false
		}

		try {
			await this.lifecycle.startLifecycle(id, instance, this.resolveStartTimeoutMs(instance))
			return true
		} catch (error) {
			const logger = pluginCtx.logger ?? this.ctx.logger
			void logger.with({ error }).error`启动 ${String(id)} 失败`
			try {
				await pluginCtx.effects.dispose()
			} catch {
				/* ignored */
			}
			runtime.delete(id)
			return false
		}
	}

	private startPlugins(
		runtime: PluginRuntime,
		graph: PluginGraph,
		plan: InitPlan<number>,
	): Promise<Set<number>> {
		return startPluginsWithStrategy(
			plan,
			(slot) => {
				const id = graph.keyOf(slot)
				return id === undefined
					? Promise.resolve(false)
					: this.instantiateAndStart(runtime, id as RuntimePluginKey)
			},
			{ strategy: this.startStrategy, concurrency: this.startConcurrency },
		)
	}

	/**
	 * 非事务化提交：
	 * - 停机：对 remove/replace 逆拓扑停机
	 * - 启动：对 add/replace 拓扑分批启动；失败只影响其依赖链
	 * - 失败插件从 singletons 中清理（下次 commit 仍会尝试重启）
	 */
	commit() {
		return this.enqueueCommit(null)
	}

	private commitRuntimeUpdate(meta: RuntimeUpdateCommitMeta) {
		return this.enqueueCommit(null, meta)
	}

	/**
	 * Strict commit:
	 * - runs a commit with feature declaration policy set to `error` for this cycle;
	 * - if any plugins failed to start, returns an error result.
	 */
	async commitStrict() {
		const commitResult = await this.enqueueCommit('error')
		if (!commitResult.ok) return commitResult
		const summary = this._lastCommit
		if (summary?.failed.length) {
			return createErr(
				new Error(`Some plugins failed to start: ${summary.failed.map(String).join(', ')}`),
			)
		}
		return commitResult
	}

	private async executeCommit(meta: RuntimeUpdateCommitMeta | null = null) {
		const summaryMeta = this.createCommitSummaryMeta(meta)
		if (
			!this.definitions.hasPendingChanges() &&
			this._pendingStart.size === 0 &&
			this._pendingRestart.size === 0
		) {
			const graph = this.graph
			this.publishCommitSummary({
				graph,
				...summaryMeta,
				added: [],
				replaced: [],
				removed: [],
				failed: [],
				restarted: [],
				touched: [],
			})
			return createOk({ graph, delta: EMPTY_DELTA })
		}

		const action = this.definitions.build()
		if (!action.ok) {
			action.err.reset()
			void this.ctx.logger.with({ error: action.err.err, detail: String(action.err.err) })
				.error`插件在依赖项解析时失败`
			return createErr(new Error('service verification failed', { cause: action.err.err }))
		}

		const { delta, graph, runtime, confirm } = action.val
		this._activeGraph = graph
		this._activeRuntime = runtime
		try {
			const oldGraph = this.graph
			const plan = this.buildCommitPlan(oldGraph, graph, {
				added: delta.added as readonly RuntimePluginKey[],
				replaced: delta.replaced as readonly PluginReplacement[],
				removed: delta.removed as readonly RuntimePluginKey[],
			})

			// No-op commit: still report state (after applying pending restarts/retries).
			if (
				delta.added.length === 0 &&
				delta.removed.length === 0 &&
				delta.replaced.length === 0 &&
				plan.toStopSlots.size === 0 &&
				plan.toStartSlots.size === 0
			) {
				confirm()
				this.publishCommitSummary({
					graph: this.graph,
					...summaryMeta,
					added: [],
					replaced: [],
					removed: [],
					failed: [],
					restarted: [],
					touched: [],
				})
				return createOk({ graph: this.graph, delta })
			}

			this.ctx.logger.info('插件变更', () => ({
				remove: [...plan.removed].map(String),
				replace: plan.replaced.map(({ from, to }) => `${String(from)} -> ${String(to)}`),
				add: [...plan.added].map(String),
				restart:
					plan.restartRequested.size > 0 ? [...plan.restartRequested].map(String) : undefined,
			}))
			await this.applyTeardown(oldGraph, plan.toStopSlots)
			confirm()

			// Ensure fresh instances for restarts/replacements.
			runtime.deleteMany(this.collectRuntimeEvictions(plan))

			let failed = new Set<RuntimePluginKey>()
			if (plan.toStartSlots.size > 0) {
				const initPlan = computeInitPlan(
					plan.toStartSlots,
					(slot) => graph.depSlotsOf(slot) as readonly number[],
				)
				const failedSlots = await this.startPlugins(runtime, graph, initPlan)
				for (const slot of failedSlots) {
					const id = graph.keyOf(slot)
					if (id !== undefined) failed.add(id as RuntimePluginKey)
				}
			}

			// Ensure failed plugins are not observable as "available" for this commit.
			// (They may have been instantiated but not successfully started.)
			if (failed.size > 0) {
				runtime.deleteMany(failed)
			}

			this.publishCommitSummary({
				graph: this.graph,
				...summaryMeta,
				added: [...plan.added],
				replaced: [...plan.replaced],
				removed: [...plan.removed],
				failed: [...failed],
				restarted: this.collectRestartedSummary(plan, failed),
				touched: [...new Set<RuntimePluginKey>([...plan.toStop, ...plan.toStart])],
			})

			// update pending retry set
			this.replacePendingStarts(failed)

			if (failed.size > 0) {
				this.ctx.logger.warn('以下插件启动失败', { failed: [...failed].map(String) })
				this.ctx.emit('commitFailed', failed)
			}

			return createOk({ graph: this.graph, delta })
		} finally {
			this._activeGraph = undefined
			this._activeRuntime = undefined
		}
	}

	private buildCommitPlan(
		oldGraph: PluginGraph,
		graph: PluginGraph,
		delta: {
			added: readonly RuntimePluginKey[]
			replaced: readonly PluginReplacement[]
			removed: readonly RuntimePluginKey[]
		},
	): CommitExecutionPlan {
		const added = new Set(delta.added)
		const replaced = [...delta.replaced]
		const removed = new Set(delta.removed)

		// Restart requests are author intent; normalize them against both the previous and next graph.
		const restartRequested = new Set(this._pendingRestart)
		this._pendingRestart.clear()

		const toStop = new Set<RuntimePluginKey>(removed)
		const toStart = new Set<RuntimePluginKey>()

		for (let i = 0; i < replaced.length; i++) {
			const { from, to } = replaced[i]!
			toStop.add(from)
			if (graph.has(to)) toStart.add(to)
		}
		for (const id of added) {
			if (graph.has(id)) toStart.add(id)
		}
		for (const id of restartRequested) {
			const stopKey = this.resolveGraphKey(oldGraph, id)
			if (stopKey && oldGraph.has(stopKey)) toStop.add(stopKey)
			const startKey = this.resolveGraphKey(graph, id)
			if (startKey && graph.has(startKey)) toStart.add(startKey)
		}

		// Retry previously failed plugins opportunistically on any later commit.
		for (const id of this._pendingStart) {
			if (toStop.has(id)) continue
			const key = this.resolveGraphKey(graph, id)
			if (key && graph.has(key)) toStart.add(key)
		}

		return {
			added,
			replaced,
			removed,
			restartRequested,
			toStop,
			toStart,
			toStopSlots: this.collectExistingSlots(oldGraph, toStop),
			toStartSlots: this.collectExistingSlots(graph, toStart),
		}
	}

	private collectExistingSlots(graph: PluginGraph, ids: Iterable<RuntimePluginKey>): Set<number> {
		const slots = new Set<number>()
		for (const id of ids) {
			const slot = graph.slotOf(id)
			if (slot !== undefined) slots.add(slot)
		}
		return slots
	}

	private collectRestartedSummary(
		plan: CommitExecutionPlan,
		failed: ReadonlySet<RuntimePluginKey>,
	): RuntimePluginKey[] {
		const structural = new Set<RuntimePluginKey>([...plan.added, ...plan.removed, ...failed])
		for (const { from, to } of plan.replaced) {
			structural.add(from)
			structural.add(to)
		}

		const restarted: RuntimePluginKey[] = []
		const seen = new Set<RuntimePluginKey>()
		for (const id of plan.toStart) {
			if (structural.has(id) || seen.has(id)) continue
			seen.add(id)
			restarted.push(id)
		}
		return restarted
	}

	private publishCommitSummary(summary: CommitSummary): void {
		this._lastCommit = summary
		this.watcherRegistry.publish(summary)
		this.ctx.emit('afterCommit', summary)
	}

	private createCommitSummaryMeta(
		meta: RuntimeUpdateCommitMeta | null,
	): Pick<CommitSummary, 'reason' | 'touchedModules' | 'autoDisabled'> {
		const touchedModules = meta ? [...new Set(meta.touchedModules)] : []
		const autoDisabled = meta ? [...new Set(meta.autoDisabled)] : []
		return meta
			? { reason: meta.reason, touchedModules, autoDisabled }
			: { touchedModules, autoDisabled }
	}

	private replacePendingStarts(ids: Iterable<RuntimePluginKey>): void {
		this._pendingStart.clear()
		for (const id of ids) this._pendingStart.add(id)
	}
}

function isFinitePositiveMs(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function readFinitePositiveMsFromMeta(metadata: unknown, key: string): number | undefined {
	if (!metadata || typeof metadata !== 'object') return undefined
	const value = (metadata as Record<string, unknown>)[key]
	return isFinitePositiveMs(value) ? value : undefined
}
