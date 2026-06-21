import type { Context } from '@pluxel/core'
import {
	runtimePluginLogPolicy,
	type PluginLogPolicySnapshot,
	type RuntimePluginLogLevel,
} from './policy'

/**
 * Persisted plugin log policy for runtime hosts.
 *
 * Stored in ConfigService "extra" so workbench changes are profile-scoped and
 * apply to the global LogTape filter without re-running configure().
 */
export const EXTRA_RUNTIME_PLUGIN_POLICY = 'runtime.logger.pluginPolicy' as const

function isRuntimePluginLogLevel(value: unknown): value is RuntimePluginLogLevel {
	return (
		value === 'off' ||
		value === 'trace' ||
		value === 'debug' ||
		value === 'info' ||
		value === 'warning' ||
		value === 'error' ||
		value === 'fatal'
	)
}

function coercePluginLogPolicySnapshot(value: unknown): PluginLogPolicySnapshot | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const raw = value as Record<string, unknown>
	const out: PluginLogPolicySnapshot = { overrides: {} }
	const defaultLevel = raw.defaultLevel
	if (isRuntimePluginLogLevel(defaultLevel)) out.defaultLevel = defaultLevel
	const overrides = raw.overrides
	if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
		for (const [pluginId, level] of Object.entries(overrides as Record<string, unknown>)) {
			if (isRuntimePluginLogLevel(level)) out.overrides[pluginId] = level
		}
	}
	return out
}

const loadByConfigService = new WeakMap<object, Promise<void>>()

export async function ensureRuntimePluginPolicyLoaded(ctx: Context): Promise<void> {
	const configService = ctx.configService
	if (!configService) return

	const existing = loadByConfigService.get(configService as object)
	if (existing) return await existing

	const task = (async () => {
		await configService.ready
		const persisted = coercePluginLogPolicySnapshot(
			configService.getExtra(EXTRA_RUNTIME_PLUGIN_POLICY),
		)
		if (persisted) runtimePluginLogPolicy.replace(persisted)
	})().catch((error) => {
		loadByConfigService.delete(configService as object)
		throw error
	})

	loadByConfigService.set(configService as object, task)
	return await task
}

export function persistRuntimePluginPolicy(ctx: Context): void {
	ctx.configService?.setExtra(EXTRA_RUNTIME_PLUGIN_POLICY, runtimePluginLogPolicy.snapshot())
}
