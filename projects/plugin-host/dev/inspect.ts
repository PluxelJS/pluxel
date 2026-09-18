import type { DevConsole, DevRunContext } from '@pluxel/host-dev/console'
import { resolveContextCapability } from '@pluxel/core/host'
import { HttpServer } from '@pluxel/services/http'
import { Logging } from '@pluxel/logging'

export default function inspect(dev: DevConsole) {
	return dev.plugins.list()
}

/** Read the live application's installed HTTP and logging capabilities. */
export async function health(dev: DevConsole, run: DevRunContext) {
	const http = resolveContextCapability(dev.ctx, HttpServer)
	const status = await http.fetch(
		new Request('http://local.dev/showcase/status', { signal: run.signal }),
	)
	const shell = await http.fetch(
		new Request('http://local.dev/__pluxel/workbench', {
			signal: run.signal,
			headers: { accept: 'text/html' },
		}),
	)
	const logging = resolveContextCapability(dev.ctx, Logging)
	logging.flushStores()
	return {
		plugins: await dev.plugins.list(),
		showcase: { status: status.status, body: await status.text() },
		workbench: { status: shell.status },
		logs: logging.stores.get('default')?.tailWindow(30) ?? [],
	}
}
