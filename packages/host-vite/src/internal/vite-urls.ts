import { styleText } from 'node:util'
import type { ViteDevServer } from 'vite'

const PLUXEL_VITE_URL_PRINTER = Symbol.for('pluxel.viteUrlPrinter')

type UrlPrinterServer = ViteDevServer & {
	[PLUXEL_VITE_URL_PRINTER]?: { options?: PluxelViteUrlPrinterOptions }
}

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
	const marked = server as UrlPrinterServer
	const installed = marked[PLUXEL_VITE_URL_PRINTER] !== undefined
	const state = (marked[PLUXEL_VITE_URL_PRINTER] ??= {})
	state.options = options
	const dispose = () => {
		if (state.options === options) state.options = undefined
	}
	if (installed) return dispose

	const printViteUrls = server.printUrls.bind(server)
	server.printUrls = () => {
		const presentation = urlPresentation(server)
		if (presentation.native) printViteUrls()
		for (const line of presentation.lines) server.config.logger.info(terminalUrlLine(line))
	}
	return dispose
}

function terminalUrlLine(line: string): string {
	const match = /^(  )➜  ([A-Za-z]+:)(\s+)(https?:\/\/\S+)$/.exec(line)
	if (!match) return line
	const [, prefix, label, spacing, url] = match
	return `${prefix}${styleText('green', '➜')}  ${styleText('bold', label!)}${spacing}${styleText('cyan', url!)}`
}

function resolvedViteOrigin(server: ViteDevServer): string | undefined {
	const value = server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0]
	return value ? new URL(value).origin : undefined
}

/** Fresh presentation from the running server; also consumed by the local dev console. */
export function readViteUrlOutput(server: ViteDevServer): string[] {
	const presentation = urlPresentation(server)
	const native = presentation.native
		? [
				...(server.resolvedUrls?.local ?? []).map((url) => `  ➜  Local:       ${url}`),
				...(server.resolvedUrls?.network ?? []).map((url) => `  ➜  Network:     ${url}`),
			]
		: []
	return [...native, ...presentation.lines]
}

function urlPresentation(server: ViteDevServer): { native: boolean; lines: string[] } {
	const current = (server as UrlPrinterServer)[PLUXEL_VITE_URL_PRINTER]?.options
	if (!current) return { native: true, lines: [] }
	const workbenchBasePath = current.workbenchBasePath()
	const origin = current.publicOrigin ?? resolvedViteOrigin(server)
	const lines: string[] = []
	if (origin) {
		if (current.publicOrigin && workbenchBasePath !== '/') {
			lines.push(`  ➜  Application: ${new URL('/', origin).href}`)
		}
		if (workbenchBasePath) {
			lines.push(`  ➜  Workbench:   ${new URL(workbenchBasePath, origin).href}`)
		}
	}
	return { native: !current.publicOrigin, lines }
}
