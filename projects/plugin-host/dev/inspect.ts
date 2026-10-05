import { defineDevConsole } from '@pluxel/host-vite/console'
import { Logging } from '@pluxel/services/logging'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export default defineDevConsole((dev) => {
	return dev.plugins.list()
})

/** Check the application's HTTP endpoints and logs. Input: { origin: 'http://localhost:5173' }. */
export const health = defineDevConsole(async (dev) => {
	const input = dev.input
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
	const status = await fetch(new URL('/showcase/status', origin), { signal: dev.signal })
	// Node fetch sends sec-fetch-mode: cors; preserve the browser navigation contract.
	const shellStatus = await new Promise<number>((resolveStatus, reject) => {
		const request = (origin.protocol === 'http:' ? httpRequest : httpsRequest)(
			new URL('/__pluxel/workbench', origin),
			{
				signal: dev.signal,
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
	const logging = dev.ctx.require(Logging)
	logging.flushStores()
	return {
		plugins: await dev.plugins.list(),
		showcase: { status: status.status, body: await status.text() },
		workbench: { status: shellStatus },
		logs: logging.stores.get('default')?.tailWindow(30) ?? [],
	}
})
