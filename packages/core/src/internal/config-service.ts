import type { Context } from '@pluxel/context'
import type { ConfigService } from '../services/config/ConfigService'

const CONFIG_SERVICE_KEY = 'configService' as const

/** @internal Explicit root-host authority for desired Plugin config. */
export function requireConfigService(ctx: Context): ConfigService {
	const service = (ctx.root as unknown as Record<PropertyKey, unknown>)[CONFIG_SERVICE_KEY]
	if (
		!service ||
		typeof service !== 'object' ||
		typeof (service as { getRawConfig?: unknown }).getRawConfig !== 'function' ||
		typeof (service as { ensureValidated?: unknown }).ensureValidated !== 'function' ||
		typeof (service as { patchConfig?: unknown }).patchConfig !== 'function'
	) {
		throw new Error('[pluxel/core] ConfigService is not installed on this Context root')
	}
	return service as ConfigService
}
