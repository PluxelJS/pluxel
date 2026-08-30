import picomatch from 'picomatch'
import {
	attachSrvxViteNodeCarrier,
	type SrvxViteNodeCarrierAttachment,
	type ViteBusinessWebSocketUpgrade,
} from '@pluxel/runtime-dev/vite'
import type { IncomingMessage } from 'node:http'
import type { Plugin } from 'vite'

import { DEFAULT_VITE_WATCH_IGNORED, VITE_WATCH_USE_POLLING } from './vite-watch'

type HttpHandler = (request: Request, env?: unknown, ctx?: unknown) => Response | Promise<Response>

export interface FetchHmrServerPluginOptions {
	exclude?: Array<string | RegExp>
	fetch: HttpHandler
	handleHotUpdate?: Plugin['handleHotUpdate']
	transformHtml?: boolean
	shouldHandle?: (request: IncomingMessage) => boolean
	/** @internal Carrier-owned business WebSocket bridge. */
	businessWebSocket?: ViteBusinessWebSocketUpgrade
}

export type BusinessWebSocketUpgrade = ViteBusinessWebSocketUpgrade

export function createFetchHmrServerPlugin(options: FetchHmrServerPluginOptions): Plugin {
	const exclude = (options.exclude ?? []).map((pattern) =>
		typeof pattern === 'string' ? picomatch(pattern) : pattern,
	)
	let attachment: SrvxViteNodeCarrierAttachment | undefined

	return {
		name: 'pluxel-fetch-hmr-server',
		config() {
			return {
				server: {
					watch: {
						ignored: [...DEFAULT_VITE_WATCH_IGNORED],
						usePolling: VITE_WATCH_USE_POLLING,
					},
				},
			}
		},
		configureServer(server) {
			attachment = attachSrvxViteNodeCarrier(server, {
				fetch: options.fetch,
				transformViteHtml: options.transformHtml !== false,
				businessWebSocket: options.businessWebSocket,
				shouldHandle(request) {
					const rawUrl = request.url ?? '/'
					for (const pattern of exclude) {
						if (pattern instanceof RegExp ? pattern.test(rawUrl) : pattern(rawUrl)) return false
					}
					return options.shouldHandle?.(request) ?? true
				},
			})
		},
		handleHotUpdate: options.handleHotUpdate,
		async closeBundle() {
			await attachment?.close()
		},
	}
}
