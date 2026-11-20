import { requireCoreRuntime } from '../context/core-context'
import type { Context } from '../context/Context'
import type { ConfigService } from '../services/config/ConfigService'

/** @internal Explicit root-host authority for desired Plugin config. */
export function requireConfigService(ctx: Context): ConfigService {
	return requireCoreRuntime(ctx).config
}
