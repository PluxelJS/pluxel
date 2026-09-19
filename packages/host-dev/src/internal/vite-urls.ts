import type { ViteDevServer } from 'vite'

const PLUXEL_VITE_URL_PRINTER = Symbol.for('pluxel.viteUrlPrinter')

export type PluxelViteUrlPrinterOptions = {
	/** Named proxy origin. Omit it to preserve Vite's native URL output. */
	publicOrigin?: string
	/** Current Workbench mount path, or undefined when the plane is disabled. */
	workbenchBasePath: () => string | undefined
}

/** Installs one route-neutral URL presenter on the host-owned Vite server. */
export function installPluxelViteUrlPrinter(
	server: ViteDevServer,
	options: PluxelViteUrlPrinterOptions,
): () => void {
	const marked = server as ViteDevServer & {
		[PLUXEL_VITE_URL_PRINTER]?: { options?: PluxelViteUrlPrinterOptions }
	}
	const installed = marked[PLUXEL_VITE_URL_PRINTER] !== undefined
	const state = (marked[PLUXEL_VITE_URL_PRINTER] ??= {})
	state.options = options
	const dispose = () => {
		if (state.options === options) state.options = undefined
	}
	if (installed) return dispose

	const printViteUrls = server.printUrls.bind(server)
	server.printUrls = () => {
		const current = state.options
		if (!current) {
			printViteUrls()
			return
		}
		const workbenchBasePath = current.workbenchBasePath()
		const origin = current.publicOrigin ?? resolvedViteOrigin(server)
		if (!current.publicOrigin) printViteUrls()
		if (!origin) return

		if (current.publicOrigin && workbenchBasePath !== '/') {
			server.config.logger.info(`  ➜  Application: ${new URL('/', origin).href}`)
		}
		if (workbenchBasePath) {
			server.config.logger.info(`  ➜  Workbench:   ${new URL(workbenchBasePath, origin).href}`)
		}
	}
	return dispose
}

function resolvedViteOrigin(server: ViteDevServer): string | undefined {
	const value = server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0]
	return value ? new URL(value).origin : undefined
}
