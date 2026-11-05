import { requestWithSignal } from './request'
import { resolveApplicationAsset } from './assets'
import type { NodeElysiaApplicationCarrier } from './node'

/** Preserve ingress identity and cancellation, then serve compiled public assets after business routes. */
export async function dispatchElysiaRequest(
	request: Request,
	dispatch: (request: Request) => Response | undefined | Promise<Response | undefined>,
	carrier: NodeElysiaApplicationCarrier,
	publicDir?: string,
): Promise<Response> {
	// srvx propagates premature response closure through the ingress request signal.
	const input = requestWithSignal(request, request.signal)
	carrier.bindRequest(input, request)
	const result = await dispatch(input)
	if (result !== undefined) return result
	const pathname = new URL(input.url).pathname
	if (
		publicDir &&
		pathname !== '/__pluxel' &&
		!pathname.startsWith('/__pluxel/') &&
		!pathname.startsWith('/@') &&
		pathname !== '/node_modules' &&
		!pathname.startsWith('/node_modules/')
	) {
		const asset = await resolveApplicationAsset(input, publicDir)
		if (asset) return asset
	}
	return new Response('Not Found', { status: 404 })
}
