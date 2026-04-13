import type { Context } from '@pluxel/core'
import type { PluxelPluginLogLevel } from '@pluxel/core/logger'

import { hmrPluginLevels } from './ensure'

/**
 * Persisted per-plugin log level overrides for HMR.
 *
 * Stored in ConfigService "extra" (single source of truth for host settings),
 * and applied to the global LogTape filter via `hmrPluginLevels`.
 */
export const EXTRA_HMR_PLUGIN_LEVELS = 'hmr.logger.pluginLevels' as const

type PersistedPluginLevels = Record<string, PluxelPluginLogLevel>

function coercePersistedPluginLevels(value: unknown): PersistedPluginLevels | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const out: PersistedPluginLevels = Object.create(null)
	for (const k in value as Record<string, unknown>) {
		if (!Object.hasOwn(value as Record<string, unknown>, k)) continue
		const v = (value as Record<string, unknown>)[k]
		if (v === null || typeof v === 'string') out[k] = v as PluxelPluginLogLevel
	}
	return out
}

const loadByConfigService = new WeakMap<object, Promise<void>>()

/**
 * Load persisted log-level overrides into the in-memory state once.
 *
 * Note: this is intentionally lazy so hosts can call ensurePluxelLogging()
 * before Context/services finish initializing.
 */
export async function ensureHmrPluginLevelsLoaded(ctx: Context): Promise<void> {
	const configService = ctx.configService
	if (!configService) return

	const existing = loadByConfigService.get(configService as object)
	if (existing) return await existing

	const task = (async () => {
		// In core this resolves immediately; in HMR it may load from disk asynchronously.
		await configService.ready

		const persisted = coercePersistedPluginLevels(configService.getExtra(EXTRA_HMR_PLUGIN_LEVELS))
		if (!persisted) return

		hmrPluginLevels.clear()
		for (const k in persisted) {
			if (!Object.hasOwn(persisted, k)) continue
			// Be tolerant to stale/invalid persisted values; skip bad entries instead of failing startup.
			try {
				hmrPluginLevels.set(k, persisted[k]!)
			} catch {
				// ignore
			}
		}
	})().catch((error) => {
		// Don't cache failures forever; allow a later call to retry.
		loadByConfigService.delete(configService as object)
		throw error
	})

	loadByConfigService.set(configService as object, task)
	return await task
}

export function persistHmrPluginLevels(ctx: Context): void {
	ctx.configService?.setExtra(EXTRA_HMR_PLUGIN_LEVELS, hmrPluginLevels.toRecord())
}
