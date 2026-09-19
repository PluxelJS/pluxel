import { installPluxelViteUrlPrinter } from '@pluxel/host-dev/internal'
import { hostEnv } from '@pluxel/host/environment'
import { resolveContextCapability } from '@pluxel/core/host'
import { HttpServer, type HttpServerApi } from '../http'
import type { NodeElysiaApplicationCarrier } from '../http/node'
import type { Plugin } from 'vite'
import type { HostDevelopmentPluginApi } from '@pluxel/host-dev/vite'
import {
	attachSrvxViteNodeCarrier,
	createViteNodeElysiaApplicationCarrier,
	type SrvxViteNodeCarrierAttachment,
} from './vite-node-carrier'

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
					if (active) throw new Error('[services/http/vite] HTTP attachment is already active')
					const http = resolveContextCapability(host.ctx, HttpServer)
					const carrier = createViteNodeElysiaApplicationCarrier(server, {
						fetch: http.fetch,
						matches: http.matchesWebSocketRoute,
					})
					const detach = http.attachApplicationCarrier(carrier)
					const removeUrlPrinter =
						'workbench' in host.ctx
							? undefined
							: installPluxelViteUrlPrinter(server, {
									publicOrigin: hostEnv.portlessOrigin,
									workbenchBasePath: () => undefined,
								})
					const current = { http, carrier }
					active = current
					try {
						transport ??= attachSrvxViteNodeCarrier(server, {
							transformViteHtml: true,
							fetch(request) {
								if (!active) return new Response('Service Unavailable', { status: 503 })
								// srvx's NodeRequest is structurally Fetch-compatible but has no native
								// Request private slots. Normalize at the carrier boundary, preserving
								// the physical request for authentication and requestIP().
								const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
								const input = new Request(request.url, {
									method: request.method,
									headers: request.headers,
									signal: request.signal,
									body: hasBody ? request.body : undefined,
									...(hasBody && request.body ? { duplex: 'half' } : {}),
								} as RequestInit)
								active.carrier.bindRequest(input, request)
								return active.http.fetch(input)
							},
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
						removeUrlPrinter?.()
						detach()
						try {
							await carrier.close()
						} catch (cleanup) {
							throw new AggregateError(
								[error, cleanup],
								'[services/http/vite] HTTP attachment cleanup failed',
								{ cause: cleanup },
							)
						}
						throw error
					}
					return async () => {
						if (active === current) active = undefined
						removeUrlPrinter?.()
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
