import { resolveContextCapability } from '@pluxel/core/host'
import { HttpServer, type HttpServerApi } from '@pluxel/services/http'
import type { NodeElysiaApplicationCarrier } from '@pluxel/services/http/node'
import type { Plugin } from 'vite'
import type { HostDevelopmentPluginApi } from './attachments'
import {
	attachSrvxViteNodeCarrier,
	createViteNodeElysiaApplicationCarrier,
	type SrvxViteNodeCarrierAttachment,
} from './internal/vite-node-carrier'

/** Borrow Vite's listener for the explicitly installed HTTP service. */
export function httpDevelopment(): Plugin<HostDevelopmentPluginApi> {
	let active: { http: HttpServerApi; carrier: NodeElysiaApplicationCarrier } | undefined
	let transport: SrvxViteNodeCarrierAttachment | undefined
	return {
		name: 'pluxel:host-http',
		apply: 'serve',
		api: {
			pluxelHost: {
				async attach({ host, server }) {
					if (active) throw new Error('[host-dev] HTTP attachment is already active')
					const http = resolveContextCapability(host.ctx, HttpServer)
					const carrier = createViteNodeElysiaApplicationCarrier(server, {
						fetch: http.fetch,
						matches: http.matchesWebSocketRoute,
					})
					const detach = http.attachApplicationCarrier(carrier)
					const current = { http, carrier }
					active = current
					try {
						transport ??= attachSrvxViteNodeCarrier(server, {
							transformViteHtml: true,
							fetch: (request) =>
								active?.http.fetch(request) ?? new Response('Service Unavailable', { status: 503 }),
							shouldHandle(request) {
								if (!active) return false
								const url = request.url ?? '/'
								if (url.startsWith('/@') || url.startsWith('/node_modules/')) return false
								return active.http.matchesRequest(
									new Request(new URL(url, 'http://local.dev'), {
										method: request.method,
										headers: { accept: String(request.headers.accept ?? '') },
									}),
								)
							},
							...(server.httpServer
								? {
										businessWebSocket: {
											matches: (request) => active?.carrier.matchesUpgrade(request) ?? false,
											handle: (request, socket, head) =>
												active?.carrier.handleUpgrade(request, socket, head),
										},
									}
								: {}),
						})
					} catch (error) {
						active = undefined
						detach()
						try {
							await carrier.close()
						} catch (cleanup) {
							throw new AggregateError(
								[error, cleanup],
								'[host-dev] HTTP attachment cleanup failed',
								{ cause: cleanup },
							)
						}
						throw error
					}
					return async () => {
						if (active === current) active = undefined
						carrier.stopAccepting()
						detach()
						await carrier.close()
					}
				},
			},
		},
		async closeBundle() {
			await transport?.close()
		},
	}
}
