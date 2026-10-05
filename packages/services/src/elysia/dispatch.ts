import { requestWithSignal } from './request'
import { resolveApplicationAsset } from './assets'
import type { NodeElysiaApplicationCarrier } from './node'

/** Preserve ingress identity and cancellation, then serve compiled public assets after business routes. */
export async function dispatchElysiaRequest(
	request: Request,
	fetch: (request: Request) => Response | Promise<Response>,
	carrier: NodeElysiaApplicationCarrier,
	publicDir?: string,
): Promise<Response> {
	// srvx propagates premature response closure through the ingress request signal.
	const input = requestWithSignal(request, request.signal)
	carrier.bindRequest(input, request)
	const result = await fetch(input)
	const pathname = new URL(input.url).pathname
	if (
		publicDir &&
		result.status === 404 &&
		pathname !== '/__pluxel' &&
		!pathname.startsWith('/__pluxel/') &&
		!pathname.startsWith('/@') &&
		pathname !== '/node_modules' &&
		!pathname.startsWith('/node_modules/')
	) {
		return (await resolveApplicationAsset(input, publicDir)) ?? result
	}
	return result
}
