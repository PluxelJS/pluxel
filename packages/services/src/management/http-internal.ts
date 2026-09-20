import type { RootContext, EffectsScope } from '@pluxel/core'
import { resolveContextCapability, enterOwnerInvocation } from '@pluxel/core/host'
import { HttpServer, type ElysiaApplicationCarrier } from '../http'
import type { WSConnectionData } from 'elysia/ws'
import { AdminAccess } from './access'
import { createHostManagementTarget } from './service'
import { createManagementEndpoint, type ManagementPeer } from './index'
import { matchesRuntimeSessionUpgrade } from './web/session/ingress'
import { RUNTIME_SESSION_PATH } from './web/session/protocol'

import type { ManagementHttpOptions } from './http'

/** @internal Shared carrier assembly; only isolated compatibility hosts supply trusted peer facts. */
export function attachManagementHttp(
	ctx: RootContext,
	effects: EffectsScope,
	options: ManagementHttpOptions = {},
	inputs: Readonly<{ requestPeer?(request: Request): ManagementPeer }> = {},
): void {
	const endpoint = createManagementEndpoint({
		authentication: resolveContextCapability(ctx, AdminAccess),
		createManagement: (session) => createHostManagementTarget(ctx, session),
		...options.bindings?.(ctx),
		onError:
			options.onError ?? ((error) => ctx.logger.error('Management operation failed', { error })),
	})
	// Subscribe to root admission closure without retaining a root invocation across the session.
	const rootLease = enterOwnerInvocation(ctx)
	const close = () => endpoint.close()
	rootLease.signal.addEventListener('abort', close, { once: true })
	rootLease.dispose()
	effects.defer(
		() => {
			rootLease.signal.removeEventListener('abort', close)
			endpoint.close()
		},
		{ tag: 'ManagementEndpoint', phase: 'shutdown' },
	)
	const http = resolveContextCapability(ctx, HttpServer)
	for (const prefix of ['/__pluxel/runtime', '/__pluxel/admin-access']) {
		const unmount = http.mountEndpoint({
			prefix,
			matchesWebSocketRoute: matchesRuntimeSessionUpgrade,
			async fetch(request, carrier) {
				const peer = carrier
					? carrierFacts(request, carrier)
					: (inputs.requestPeer?.(request) ?? {})
				if (
					new URL(request.url).pathname !== RUNTIME_SESSION_PATH ||
					!matchesRuntimeSessionUpgrade(request)
				)
					return (await endpoint.fetch(request, peer)) ?? new Response('Not Found', { status: 404 })
				const prepared = endpoint.prepareUpgrade(request, peer)
				if (prepared.accepted === false) return prepared.response
				const connection = prepared.connection
				let accepted = false
				try {
					accepted =
						carrier?.upgrade({
							request,
							upgradeRequest: request,
							ownerKey: 'pluxel.management',
							signal: connection.signal,
							release: () => connection.release(),
							data: {
								id: undefined,
								context: Object.freeze({ pluxelManagement: true }),
								open: (socket) =>
									connection.open({
										get readyState() {
											return socket.readyState
										},
										send: (message) => {
											const sent = socket.send(message)
											return typeof sent === 'number' ? sent > 0 : undefined
										},
										close: (code, reason) => socket.raw.close(code, reason),
									}),
								message: (_socket, message) => connection.receive(message),
								close: (_socket, code, reason) => connection.transportClosed(code, reason),
							} satisfies WSConnectionData,
						}) ?? false
				} finally {
					if (!accepted) connection.release()
				}
				return accepted
					? new Response(null, { status: 204 })
					: new Response('Management carrier unavailable', { status: 503 })
			},
		})
		effects.defer(unmount, { tag: 'ManagementHttpMount', phase: 'shutdown' })
	}
}

function carrierFacts(request: Request, carrier: ElysiaApplicationCarrier | undefined) {
	if (!carrier) return {}
	const metadata = carrier.metadata
	return {
		address: carrier.requestIP(request)?.address,
		secure: metadata.url.protocol === 'https:',
		origin: metadata.url.origin,
	}
}
