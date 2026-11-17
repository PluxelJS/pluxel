import type { Script } from '@pluxel/agent-sdk/host'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export default ((sdk) => {
	return sdk.plugins.list()
}) satisfies Script

/** Check the application's HTTP endpoints and logs. Input: { origin: 'http://localhost:5173' }. */
export const health = (async (sdk, run) => {
	const input = run.input
	if (
		typeof input !== 'object' ||
		input === null ||
		!('origin' in input) ||
		typeof input.origin !== 'string'
	) {
		throw new TypeError('health requires input.origin: an HTTP(S) application URL')
	}
	const origin = new URL(input.origin)
	if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
		throw new TypeError('health requires an HTTP(S) application URL')
	}
	const status = await fetch(new URL('/showcase/status', origin), { signal: run.signal })
	// Node fetch sends sec-fetch-mode: cors; preserve the browser navigation contract.
	const shellStatus = await new Promise<number>((resolveStatus, reject) => {
		const request = (origin.protocol === 'http:' ? httpRequest : httpsRequest)(
			new URL('/__pluxel/workbench', origin),
			{
				signal: run.signal,
				headers: {
					accept: 'text/html',
					'sec-fetch-mode': 'navigate',
					'sec-fetch-dest': 'document',
				},
			},
			(response) => {
				response.once('error', reject)
				response.once('end', () => resolveStatus(response.statusCode ?? 0))
				response.resume()
			},
		)
		request.once('error', reject)
		request.end()
	})
	const logging = sdk.ctx.logging
	if (!logging) throw new Error('health requires runtime.logtape')
	logging.flushStores()
	const plugins = await sdk.plugins.list()
	return {
		plugins,
		showcase: { status: status.status, body: await status.text() },
		workbench: { status: shellStatus },
		logs: logging.stores.get('default')?.tailWindow(30) ?? [],
	}
}) satisfies Script
