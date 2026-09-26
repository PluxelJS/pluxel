import { defineDevConsole } from '@pluxel/host-dev/console'
import { Logging } from '@pluxel/services/logging'

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
	const shell = await fetch(new URL('/__pluxel/workbench', origin), {
		signal: dev.signal,
		headers: { accept: 'text/html' },
	})
	const logging = dev.ctx.require(Logging)
	logging.flushStores()
	return {
		plugins: await dev.plugins.list(),
		showcase: { status: status.status, body: await status.text() },
		workbench: { status: shell.status },
		logs: logging.stores.get('default')?.tailWindow(30) ?? [],
	}
})
