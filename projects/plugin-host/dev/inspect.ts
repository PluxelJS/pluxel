import type { ProjectScript } from '@pluxel/host-vite/project'
import { Result } from '@pluxel/core/better-result'
import { Logging } from '@pluxel/core/logging'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export default ((sdk) => {
	return sdk.plugins.list()
}) satisfies ProjectScript

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
	const logging = sdk.dev.ctx.require(Logging)
	logging.flushStores()
	const plugins = await sdk.plugins.list()
	if (plugins.isErr()) return plugins
	return Result.ok({
		plugins: plugins.value,
		showcase: { status: status.status, body: await status.text() },
		workbench: { status: shellStatus },
		logs: logging.stores.get('default')?.tailWindow(30) ?? [],
	})
}) satisfies ProjectScript
