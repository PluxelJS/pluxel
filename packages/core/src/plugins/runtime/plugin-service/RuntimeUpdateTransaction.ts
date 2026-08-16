import { createErr } from 'option-t/plain_result'
import type { PluginConstructor, PluginIdentifier } from '../../types'
import type { PluginNodeSlot } from '../identity'
import { collectPluginLifecycleNotStarted, type PluginLifecycleReport } from './LifecycleReport'
import type { RuntimeModuleDeclaration, RuntimeModuleSnapshot } from './RuntimeModuleRegistry'

const DEFAULT_RUNTIME_UPDATE_REASON: RuntimeUpdateReason = 'startup'
const RUNTIME_UPDATE_ALREADY_CLOSED_MESSAGE = 'Runtime update transaction is already closed'

export type CascadeOptions = { cascadeDependents?: boolean }
export type ReplacePluginOptions = CascadeOptions & { provideBase?: boolean }
export type RuntimeUpdateReason = string

export type RuntimeUpdateOptions = {
	reason?: RuntimeUpdateReason
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
	autoDisabled?: readonly PluginNodeSlot[]
}

export type RuntimeUpdateTransaction<TCommitResult = unknown> = {
	readonly reason: RuntimeUpdateReason
	register(Plugin: PluginConstructor, opts?: { provideBase?: boolean }): void
	unregister(id: PluginIdentifier, opts?: CascadeOptions): void
	replace(target: PluginIdentifier, next: PluginConstructor, opts?: ReplacePluginOptions): void
	upsertModule(module: RuntimeModuleDeclaration): void
	removeModule(moduleId: string): void
	markAffectedModule(moduleId: string): void
	markAffectedModules(moduleIds: Iterable<string>): void
	restart(id: PluginIdentifier, opts?: CascadeOptions): void
	commit(options?: RuntimeUpdateCommitOptions): Promise<TCommitResult>
	rollback(): void
}

export type RuntimeUpdateCommitMeta = {
	reason: RuntimeUpdateReason
	affectedModules: readonly string[]
	autoDisabled: readonly PluginNodeSlot[]
}

type RuntimeUpdateCommitSummaryLike = {
	lifecycleReport: PluginLifecycleReport
}

export type RuntimeUpdateController<TCommitResult> = {
	lastCommitSummary(): RuntimeUpdateCommitSummaryLike | undefined
	register(Plugin: PluginConstructor, opts?: { provideBase?: boolean }): void
	unregister(id: PluginIdentifier, opts?: CascadeOptions): void
	replace(target: PluginIdentifier, next: PluginConstructor, opts?: ReplacePluginOptions): void
	restart(id: PluginIdentifier, opts?: CascadeOptions): void
	commitDraft(meta: RuntimeUpdateCommitMeta): Promise<TCommitResult>
	completeTransaction(tx: RuntimeUpdateTransaction<TCommitResult>): void
	rollbackDraft(tx: RuntimeUpdateTransaction<TCommitResult>): void
	snapshotRuntimeModule(moduleId: string): RuntimeModuleSnapshot
	restoreRuntimeModule(moduleId: string, snapshot: RuntimeModuleSnapshot): void
	upsertRuntimeModule(module: RuntimeModuleDeclaration): void
	removeRuntimeModule(moduleId: string): void
}

export class PluginRuntimeUpdateTransaction<
	TCommitResult extends { ok: boolean },
> implements RuntimeUpdateTransaction<TCommitResult> {
	public readonly reason: RuntimeUpdateReason
	private closed = false
	private readonly moduleSnapshots = new Map<string, RuntimeModuleSnapshot>()
	private readonly affectedModules = new Set<string>()

	public constructor(
		private readonly controller: RuntimeUpdateController<TCommitResult>,
		options: RuntimeUpdateOptions = {},
	) {
		this.reason = options.reason ?? DEFAULT_RUNTIME_UPDATE_REASON
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
		this.affectedModules.add(module.moduleId)
		this.controller.upsertRuntimeModule(module)
	}

	public removeModule(moduleId: string): void {
		this.assertOpen()
		this.recordModuleSnapshot(moduleId)
		this.affectedModules.add(moduleId)
		this.controller.removeRuntimeModule(moduleId)
	}

	public markAffectedModule(moduleId: string): void {
		this.assertOpen()
		this.affectedModules.add(moduleId)
	}

	public markAffectedModules(moduleIds: Iterable<string>): void {
		this.assertOpen()
		for (const moduleId of moduleIds) this.affectedModules.add(moduleId)
	}

	public restart(id: PluginIdentifier, opts?: CascadeOptions): void {
		this.assertOpen()
		this.controller.restart(id, opts)
	}

	public async commit(options: RuntimeUpdateCommitOptions = {}): Promise<TCommitResult> {
		this.assertOpen()
		const rollbackOnFailure = options.rollbackOnFailure ?? true
		const result = await this.controller.commitDraft({
			reason: this.reason,
			affectedModules: [...this.affectedModules],
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
		this.affectedModules.clear()

		const failed = options.strict
			? collectPluginLifecycleNotStarted(this.controller.lastCommitSummary()?.lifecycleReport)
			: []
		if (failed.length > 0) {
			// The controller's concrete commit result is a plain-result union. This generic preserves that
			// exact return type, but TypeScript cannot prove its error branch from the `{ ok: boolean }` bound.
			return createErr(createPluginsFailedToStartError(failed)) as unknown as TCommitResult
		}

		return result
	}

	public rollback(): void {
		if (this.closed) return
		this.closed = true
		this.rollbackModules()
		this.affectedModules.clear()
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
		if (this.closed) throw new Error(RUNTIME_UPDATE_ALREADY_CLOSED_MESSAGE)
	}
}

export function createPluginsFailedToStartError(failed: readonly PluginNodeSlot[]): Error {
	return new Error(
		`Some plugins failed to start: ${failed.map((slot) => slot.definition.exportName).join(', ')}`,
	)
}
