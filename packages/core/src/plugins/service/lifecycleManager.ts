// lifecycleManager.ts
// Lifecycle slot + actor orchestration for plugins.
// Extracted from PluginService to keep commit logic readable while preserving
// identical runtime behavior.

import type { Context } from '@pluxel/context'
import { BasePlugin } from '../BasePlugin'
import {
	type LifecycleSnapshot,
	lifecycleSelectors,
	PluginLifecycleActor,
} from '../lifecycle/pluginActor'
import type { PluginIdentifier } from '../types'

const PLUGIN_LIFECYCLE = Symbol.for('pluxel:plugin:lifecycle')

export class LifecycleManager {
	constructor(
		private readonly ctx: Context,
		private readonly startTimeoutMs: number,
		private readonly stopTimeoutMs: number,
	) {}

	/* ─────────────────────────── Lifecycle Slot ─────────────────────────── */

	private ensureLifecycleSlot(plugin: BasePlugin): {
		[PLUGIN_LIFECYCLE]: PluginLifecycleActor | null
	} {
		if (!Object.hasOwn(plugin, PLUGIN_LIFECYCLE)) {
			Object.defineProperty(plugin, PLUGIN_LIFECYCLE, {
				value: null,
				writable: true,
				configurable: false,
				enumerable: false,
			})
		}
		return plugin as any
	}

	private getLifecycle(plugin: BasePlugin): PluginLifecycleActor | undefined {
		return this.ensureLifecycleSlot(plugin)[PLUGIN_LIFECYCLE] ?? undefined
	}

	private setLifecycle(plugin: BasePlugin, ref?: PluginLifecycleActor) {
		this.ensureLifecycleSlot(plugin)[PLUGIN_LIFECYCLE] = ref ?? null
	}

	private createLifecycle(id: PluginIdentifier, plugin: BasePlugin): PluginLifecycleActor {
		const ref = new PluginLifecycleActor(
			{ autoStart: false, useErrorChannel: true },
			{ id, runtime: BasePlugin.getLifecycleRuntime(plugin) },
		)
		ref.subscribe({
			error: (err) =>
				this.ctx.logger?.error?.(err, `[actor:${String((id as any)?.name ?? id)}] unhandled error`),
		})
		ref.start()
		this.setLifecycle(plugin, ref)
		return ref
	}

	private ensureLifecycle(id: PluginIdentifier, plugin: BasePlugin): PluginLifecycleActor {
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

	async startLifecycle(id: PluginIdentifier, plugin: BasePlugin): Promise<void> {
		const ref = this.ensureLifecycle(id, plugin)
		if (lifecycleSelectors.isRunning(ref.getSnapshot?.())) return

		ref.send({ type: 'START' })

		let snapshot: LifecycleSnapshot
		try {
			snapshot = await ref.waitForStable(this.startTimeoutMs)
		} catch (error) {
			await this.stopLifecycle(id, plugin, ref)
			throw new Error(`Plugin ${String(id)} start timeout after ${this.startTimeoutMs}ms`, {
				cause: error,
			})
		}

		if (lifecycleSelectors.isRunning(snapshot)) return

		const capturedErr: unknown =
			(ref.getSnapshot?.() as any)?.context?.err ??
			(snapshot as any)?.context?.err ??
			(snapshot as any)?.error

		await this.stopLifecycle(id, plugin, ref)

		if (capturedErr instanceof Error) throw capturedErr
		if (capturedErr != null) throw new Error(String(capturedErr), { cause: capturedErr })
		throw new Error(`Plugin ${String(id)} failed to start`)
	}

	async stopLifecycle(
		id: PluginIdentifier,
		plugin: BasePlugin,
		ref?: PluginLifecycleActor,
	): Promise<void> {
		const lifecycle = ref ?? this.getLifecycle(plugin)
		if (!lifecycle) return

		try {
			lifecycle.send({ type: 'STOP' })
		} catch {
			/* ignore */
		}

		await this.waitUntilStopped(lifecycle)
		this.setLifecycle(plugin)
	}

	private async waitUntilStopped(ref: PluginLifecycleActor): Promise<void> {
		if (lifecycleSelectors.isStopped(ref.getSnapshot?.())) return
		try {
			await ref.waitForStopped(this.stopTimeoutMs)
		} catch {
			/* ignore */
		}
	}
}
