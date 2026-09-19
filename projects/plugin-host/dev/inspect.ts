import { defineDevConsole } from '@pluxel/host-dev/console'
import { HttpServer } from '@pluxel/services/http'
import { Logging } from '@pluxel/logging'

export default defineDevConsole((dev) => {
	return dev.plugins.list()
})

/** Read the live application's installed HTTP and logging capabilities. */
export const health = defineDevConsole(async (dev) => {
	const http = dev.ctx.require(HttpServer)
	const status = await http.fetch(
		new Request('http://local.dev/showcase/status', { signal: dev.signal }),
	)
	const shell = await http.fetch(
		new Request('http://local.dev/__pluxel/workbench', {
			signal: dev.signal,
			headers: { accept: 'text/html' },
		}),
	)
	const logging = dev.ctx.require(Logging)
	logging.flushStores()
	return {
		plugins: await dev.plugins.list(),
		showcase: { status: status.status, body: await status.text() },
		workbench: { status: shell.status },
		logs: logging.stores.get('default')?.tailWindow(30) ?? [],
	}
})
