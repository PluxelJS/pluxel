import { resolveContextCapability } from '@pluxel/context'
import type { Context } from '../context/Context'
import { CONFIG_SERVICE_CAPABILITY } from '../context/core-capabilities'
import type { ConfigService } from '../services/config/ConfigService'

/** @internal Explicit root-host authority for desired Plugin config. */
export function requireConfigService(ctx: Context): ConfigService {
	return resolveContextCapability(ctx.root, CONFIG_SERVICE_CAPABILITY)
}
