// lifecycleManager.ts
// Lifecycle slot + actor orchestration for plugins.
// Extracted from PluginService to keep commit logic readable while preserving
// identical runtime behavior.

import type { Context } from '@pluxel/context'
import { BasePlugin } from '../../composition/BasePlugin'
import type { PluginIdentifier } from '../../types'
import type { RuntimePluginKey } from '../identity'
import { type LifecycleSnapshot, lifecycleSelectors, PluginLifecycleActor } from '../PluginActor'

const PLUGIN_LIFECYCLE_SLOT_KEY = 'pluxel:plugin:lifecycle'
const PLUGIN_LIFECYCLE_SLOT = Symbol.for(PLUGIN_LIFECYCLE_SLOT_KEY)

export class LifecycleManager {
	constructor(
		private readonly ctx: Context,
		private readonly startTimeoutMs: number,
		private readonly stopTimeoutMs: number,
	) {}

	/* ─────────────────────────── Lifecycle Slot ─────────────────────────── */

	private ensureLifecycleSlot(plugin: BasePlugin): {
		[PLUGIN_LIFECYCLE_SLOT]: PluginLifecycleActor | null
	} {
		if (!Object.hasOwn(plugin, PLUGIN_LIFECYCLE_SLOT)) {
			Object.defineProperty(plugin, PLUGIN_LIFECYCLE_SLOT, {
				value: null,
				writable: true,
				configurable: false,
				enumerable: false,
			})
		}
		return plugin as unknown as { [PLUGIN_LIFECYCLE_SLOT]: PluginLifecycleActor | null }
	}

	private getLifecycle(plugin: BasePlugin): PluginLifecycleActor | undefined {
		return this.ensureLifecycleSlot(plugin)[PLUGIN_LIFECYCLE_SLOT] ?? undefined
	}

	private setLifecycle(plugin: BasePlugin, ref?: PluginLifecycleActor) {
		this.ensureLifecycleSlot(plugin)[PLUGIN_LIFECYCLE_SLOT] = ref ?? null
	}

	private createLifecycle(
		id: PluginIdentifier | RuntimePluginKey,
		plugin: BasePlugin,
	): PluginLifecycleActor {
		const ref = new PluginLifecycleActor(
			{ autoStart: false, useErrorChannel: true },
			{ id, runtime: BasePlugin.getLifecycleRuntime(plugin) },
		)
		ref.subscribe({
			error: (err) => {
				const label =
					typeof id === 'function'
						? ((id as { readonly name?: string }).name ?? String(id))
						: String(id)
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
		id: PluginIdentifier | RuntimePluginKey,
		plugin: BasePlugin,
	): PluginLifecycleActor {
		const existing = this.getLifecycle(plugin)
		if (existing) {
			if (!lifecycleSelectors.isStopped(existing.getSnapshot?.())) return existing
			this.setLifecycle(plugin)
		}
		return this.createLifecycle(id, plugin)
	}

	getSnapshot(plugin: BasePlugin): LifecycleSnapshot | undefined {
		return this.getLifecycle(plugin)?.getSnapshot?.()
	}

	isRunning(plugin: BasePlugin | undefined): boolean {
		if (!plugin) return false
		return lifecycleSelectors.isRunning(this.getSnapshot(plugin))
	}

	/* ─────────────────────────── Lifecycle Management ─────────────────────────── */

	async startLifecycle(
		id: PluginIdentifier | RuntimePluginKey,
		plugin: BasePlugin,
		timeoutMs?: number,
	): Promise<void> {
		const ref = this.ensureLifecycle(id, plugin)
		if (lifecycleSelectors.isRunning(ref.getSnapshot?.())) return

		ref.send({ type: 'START' })

		const startTimeoutMs = normalizeTimeoutMs(timeoutMs, this.startTimeoutMs)

		let snapshot: LifecycleSnapshot
		try {
			snapshot = await ref.waitForStable(startTimeoutMs)
		} catch (error) {
			await this.stopLifecycle(id, plugin, { ref })
			throw new Error(`Plugin ${String(id)} start timeout after ${startTimeoutMs}ms`, {
				cause: error,
			})
		}

		if (lifecycleSelectors.isRunning(snapshot)) {
			try {
				this.ctx.emit('afterStart', plugin.ctx)
			} catch {
				// ignore: events service may be overridden
			}
			return
		}

		const refSnap = ref.getSnapshot?.() as unknown as
			| { context?: { err?: unknown }; error?: unknown }
			| undefined
		const stableSnap = snapshot as unknown as { context?: { err?: unknown }; error?: unknown }
		const capturedErr: unknown =
			refSnap?.context?.err ?? stableSnap.context?.err ?? stableSnap.error

		await this.stopLifecycle(id, plugin, { ref })

		const pluginCtx = plugin.ctx
		const err =
			capturedErr instanceof Error
				? capturedErr
				: capturedErr !== null && capturedErr !== undefined
					? new Error(String(capturedErr), { cause: capturedErr })
					: new Error(`Plugin ${String(id)} failed to start`)

		try {
			this.ctx.emit('startError', pluginCtx, err)
		} catch {
			// ignore: events service may be overridden
		}
		throw err
	}

	async stopLifecycle(
		_id: PluginIdentifier | RuntimePluginKey,
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

		const timeoutMs = normalizeTimeoutMs(opts?.timeoutMs, this.stopTimeoutMs)
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
		} catch {
			/* ignore */
		}
		return ref.getSnapshot?.()
	}
}

function normalizeTimeoutMs(value: number | undefined, fallback: number): number {
	if (value === null || value === undefined) return fallback
	if (!Number.isFinite(value)) return fallback
	const ms = Math.floor(value)
	return ms > 0 ? ms : fallback
}
