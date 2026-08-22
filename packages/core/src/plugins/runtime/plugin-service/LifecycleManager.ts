// lifecycleManager.ts
// Lifecycle slot + actor orchestration for plugins.
// Extracted from PluginService to keep commit logic readable while preserving
// identical runtime behavior.

import type { Context } from '@pluxel/context'
import { BasePlugin, getPluginLifecycleAdapter } from '../../composition/BasePlugin'
import {
	formatPluginNodeReference,
	type PluginNodeSlot,
	type PluginSlotRegistry,
} from '../identity'
import { type LifecycleSnapshot, lifecycleSelectors, PluginLifecycleActor } from '../PluginActor'

const lifecycles = new WeakMap<BasePlugin, PluginLifecycleActor>()

export type LifecycleStartResult =
	| Readonly<{ ok: true }>
	| Readonly<{
			ok: false
			startError: Error
			drainError?: unknown
	  }>

const LIFECYCLE_STARTED: LifecycleStartResult = Object.freeze({ ok: true })

export class LifecycleManager {
	constructor(
		private readonly ctx: Context,
		private readonly slots: PluginSlotRegistry,
		private readonly startTimeoutMs: number,
		private readonly drainTimeoutMs: number,
	) {}

	/* ─────────────────────────── Lifecycle Slot ─────────────────────────── */

	private getLifecycle(plugin: BasePlugin): PluginLifecycleActor | undefined {
		return lifecycles.get(plugin)
	}

	private setLifecycle(plugin: BasePlugin, ref?: PluginLifecycleActor) {
		if (ref) lifecycles.set(plugin, ref)
		else lifecycles.delete(plugin)
	}

	private createLifecycle(
		id: PluginNodeSlot,
		plugin: BasePlugin,
		onLateError?: (error: unknown, phase: 'start' | 'drain') => void,
	): PluginLifecycleActor {
		const ref = new PluginLifecycleActor(
			{ autoStart: false, useErrorChannel: true, onLateError },
			{ id, runtime: getPluginLifecycleAdapter(plugin) },
		)
		ref.subscribe({
			error: (err) => {
				const label = formatPluginNodeReference(this.slots.nodeAddress(id))
				this.ctx.logger.error('actor {actor} unhandled error', {
					actor: label,
					error: err,
				})
			},
		})
		ref.start()
		this.setLifecycle(plugin, ref)
		return ref
	}

	private ensureLifecycle(
		id: PluginNodeSlot,
		plugin: BasePlugin,
		onLateError?: (error: unknown, phase: 'start' | 'drain') => void,
	): PluginLifecycleActor {
		const existing = this.getLifecycle(plugin)
		if (existing) {
			if (!lifecycleSelectors.isStopped(existing.getSnapshot?.())) return existing
			this.setLifecycle(plugin)
		}
		return this.createLifecycle(id, plugin, onLateError)
	}

	getSnapshot(plugin: BasePlugin): LifecycleSnapshot | undefined {
		return this.getLifecycle(plugin)?.getSnapshot?.()
	}

	isRunning(plugin: BasePlugin | undefined): boolean {
		if (!plugin) return false
		return lifecycleSelectors.isRunning(this.getSnapshot(plugin))
	}

	/* ─────────────────────────── Lifecycle Workbench ─────────────────────────── */

	async startLifecycle(
		id: PluginNodeSlot,
		plugin: BasePlugin,
		timeoutMs?: number,
		onLateError?: (error: unknown, phase: 'start' | 'drain') => void,
	): Promise<LifecycleStartResult> {
		const ref = this.ensureLifecycle(id, plugin, onLateError)
		if (lifecycleSelectors.isRunning(ref.getSnapshot?.())) return LIFECYCLE_STARTED

		ref.send({ type: 'START' })

		const startTimeoutMs = normalizeTimeoutMs(timeoutMs, this.startTimeoutMs)

		let snapshot: LifecycleSnapshot
		try {
			snapshot = await ref.waitForStable(startTimeoutMs)
		} catch (cause) {
			return await this.failedStart(
				id,
				plugin,
				ref,
				new Error(
					`Plugin ${formatPluginNodeReference(this.slots.nodeAddress(id))} start timeout after ${startTimeoutMs}ms`,
					{ cause },
				),
			)
		}

		if (lifecycleSelectors.isRunning(snapshot)) {
			return LIFECYCLE_STARTED
		}

		const refSnap = ref.getSnapshot?.() as unknown as
			| { context?: { err?: unknown }; error?: unknown }
			| undefined
		const stableSnap = snapshot as unknown as { context?: { err?: unknown }; error?: unknown }
		const capturedErr: unknown =
			refSnap?.context?.err ?? stableSnap.context?.err ?? stableSnap.error

		const err =
			capturedErr instanceof Error
				? capturedErr
				: capturedErr !== null && capturedErr !== undefined
					? new Error(String(capturedErr), { cause: capturedErr })
					: new Error(
							`Plugin ${formatPluginNodeReference(this.slots.nodeAddress(id))} failed to start`,
						)
		return await this.failedStart(id, plugin, ref, err)
	}

	/** Drain a constructed generation that failed before lifecycle start admission. */
	async drainUnstartedGeneration(id: PluginNodeSlot, plugin: BasePlugin): Promise<unknown> {
		const ref = this.ensureLifecycle(id, plugin)
		const snapshot = await this.stopLifecycle(id, plugin, { ref })
		return lifecycleDrainError(ref, snapshot)
	}

	private async failedStart(
		id: PluginNodeSlot,
		plugin: BasePlugin,
		ref: PluginLifecycleActor,
		startError: Error,
	): Promise<LifecycleStartResult> {
		let snapshot: LifecycleSnapshot | undefined
		let drainError: unknown
		try {
			snapshot = await this.stopLifecycle(id, plugin, { ref })
			drainError = lifecycleDrainError(ref, snapshot)
		} catch (error) {
			drainError = error
		}
		return Object.freeze({
			ok: false,
			startError,
			...(drainError === undefined ? {} : { drainError }),
		})
	}

	async stopLifecycle(
		_id: PluginNodeSlot,
		plugin: BasePlugin,
		opts?: { ref?: PluginLifecycleActor; timeoutMs?: number },
	): Promise<LifecycleSnapshot | undefined> {
		const lifecycle = opts?.ref ?? this.getLifecycle(plugin)
		if (!lifecycle) return undefined

		try {
			lifecycle.send({ type: 'STOP' })
		} catch {
			/* ignore */
		}

		const timeoutMs = normalizeTimeoutMs(opts?.timeoutMs, this.drainTimeoutMs)
		const snapshot = await this.waitUntilStopped(lifecycle, timeoutMs)
		this.setLifecycle(plugin)
		return snapshot
	}

	private async waitUntilStopped(
		ref: PluginLifecycleActor,
		timeoutMs: number,
	): Promise<LifecycleSnapshot | undefined> {
		const current = ref.getSnapshot?.()
		if (lifecycleSelectors.isStopped(current)) return current
		try {
			return await ref.waitForStopped(timeoutMs)
		} catch (cause) {
			const latest = ref.getSnapshot?.()
			if (!latest) return undefined
			const drainError = ref.getDrainError()
			const error =
				drainError === undefined
					? new Error(`Plugin generation drain timeout after ${timeoutMs}ms`, { cause })
					: drainError instanceof Error
						? drainError
						: new Error(String(drainError), { cause: drainError })
			return {
				...latest,
				context: { ...latest.context, err: error, failedStep: 'drain' },
			}
		}
	}
}

function lifecycleDrainError(
	ref: PluginLifecycleActor,
	snapshot: LifecycleSnapshot | undefined,
): unknown {
	const drainError = ref.getDrainError()
	if (drainError !== undefined) return drainError
	if (snapshot?.context.failedStep !== 'drain') return undefined
	return (
		snapshot.context.err ??
		new Error(`Plugin generation ${String(snapshot.context.id)} failed to drain`)
	)
}

function normalizeTimeoutMs(value: number | undefined, fallback: number): number {
	if (value === null || value === undefined) return fallback
	if (!Number.isFinite(value)) return fallback
	const ms = Math.floor(value)
	return ms > 0 ? ms : fallback
}
