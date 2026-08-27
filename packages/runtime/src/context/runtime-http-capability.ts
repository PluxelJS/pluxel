import type { Context } from '@pluxel/core'
import {
	defineContextCapability,
	resolveContextCapability,
	type ContextCapability,
} from '@pluxel/core/internal'

import type { HttpService } from '../services/http/HttpService'

export const RUNTIME_HTTP_CAPABILITY: ContextCapability<HttpService> =
	defineContextCapability<HttpService>('runtime.http.application')

/** @internal Resolve the host-owned carrier/control application without projecting it to Context. */
export function requireRuntimeHttpService(ctx: Context): HttpService {
	return resolveContextCapability(ctx.root, RUNTIME_HTTP_CAPABILITY)
}
