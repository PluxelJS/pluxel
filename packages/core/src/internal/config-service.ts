import { resolveContextService } from '@pluxel/context/internal'
import type { Context } from '../context/Context'
import { PluginConfigService } from '../context/core-capabilities'
import type { ConfigService } from '../services/config/ConfigService'

/** @internal Explicit root-host authority for desired Plugin config. */
export function requireConfigService(ctx: Context): ConfigService {
	return resolveContextService(ctx.root, PluginConfigService)
}
