import type { PluginHost } from '@pluxel/host'
import { resolveContextCapability } from '@pluxel/core/host'
import { HttpServer } from '../http'

/** Selecting this adapter requires the Host to have installed the HTTP service. */
export function createHostHttpHandler(host: PluginHost): (request: Request) => Promise<Response> {
	const http = resolveContextCapability(host.ctx, HttpServer)
	return http.fetch.bind(http)
}
