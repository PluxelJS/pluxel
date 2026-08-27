import {
	enterOwnerInvocation,
	type CoreCommitPublication,
	type CoreGenerationFinalization,
	type CoreGenerationRejection,
	type CoreGenerationSettlement,
	type CorePluginLifecycleHooks,
} from '@pluxel/core/internal'
import { pluginNodeIndexKey, type Context as PluxelContext, type PluginContext } from '@pluxel/core'
import { Elysia, type AnyElysia } from 'elysia'
import { createAdapter } from 'elysia/adapter'
import { WebStandardAdapter } from 'elysia/adapter/web-standard'

import type {
	ElysiaCarrierRequestAddress,
	ElysiaApplicationCarrier,
	ElysiaWebSocketUpgrade,
} from './elysia-application-carrier'

type RouteKind = 'http' | 'websocket'

type ApplicationRoute = Readonly<{
	kind: RouteKind
	method: string
	path: string
}>

type ApplicationContribution = Readonly<{
	ctx: PluginContext
	ownerKey: string
	app: AnyElysia
	serverView: OwnerElysiaServerView
	routes: readonly ApplicationRoute[]
}>

type ApplicationSnapshot = Readonly<{
	contributions: readonly ApplicationContribution[]
	byOwnerKey: ReadonlyMap<string, ApplicationContribution>
	httpSelectors: ReadonlyMap<string, Elysia>
	webSocketSelector?: Elysia
}>

type OwnerElysiaServerView = Readonly<{
	id: string
	url: URL
	port: number
	hostname: string
	development: boolean
	readonly pendingRequests: number
	readonly pendingWebSockets: number
	fetch(request: Request): Response | Promise<Response>
	upgrade(request: Request, options?: { headers?: HeadersInit; data?: unknown }): boolean
	publish(
		topic: string,
		data: string | ArrayBufferView | ArrayBufferLike,
		compress?: boolean,
	): number
	requestIP(request: Request): ElysiaCarrierRequestAddress | null
	timeout(request: Request, seconds: number): never
	stop(closeActiveConnections?: boolean): never
	reload(options: unknown): never
	ref(): never
	unref(): never
	[Symbol.dispose](): never
}>

type UpgradeIngress = Readonly<{
	request: Request
	ctx: PluginContext
	ownerKey: string
	lease: ReturnType<typeof enterOwnerInvocation>
	settleRequest(): void
}> & {
	transferred: boolean
}

type PreparedApplicationPublication = Readonly<{
	publication: CoreCommitPublication
	snapshot: ApplicationSnapshot
}>

const ROUTE_OWNER_HEADER = 'x-pluxel-route-owner'
const WILDCARD_METHOD = '*'
const EMPTY_SNAPSHOT: ApplicationSnapshot = Object.freeze({
	contributions: Object.freeze([]),
	byOwnerKey: new Map(),
	httpSelectors: new Map(),
})

const PLUXEL_ELYSIA_ADAPTER = createAdapter({
	...WebStandardAdapter,
	name: 'pluxel-srvx',
	runtime: 'unknown',
	websocket: true,
})

function isReservedPath(path: string): boolean {
	return path === '/__pluxel' || path.startsWith('/__pluxel/')
}

function applicationRoutes(app: AnyElysia): readonly ApplicationRoute[] {
	return Object.freeze(
		app.routes.map((route) => {
			const method = String(route.method).toUpperCase()
			return Object.freeze({
				kind: method === 'WS' ? ('websocket' as const) : ('http' as const),
				method,
				path: route.path,
			})
		}),
	)
}

function assertApplicationRoutesAvailable(
	ctx: PluginContext,
	routes: readonly ApplicationRoute[],
): void {
	for (const route of routes) {
		if (!isReservedPath(route.path)) continue
		throw new Error(
			`[pluxel/runtime] Elysia ${route.method} route "${route.path}" from "${ctx.pluginInfo.displayName}" uses the reserved /__pluxel namespace`,
		)
	}
}

type ApplicationRouteOwner = Readonly<{
	contribution: ApplicationContribution
	route: ApplicationRoute
}>

type ApplicationRouteIndex = Map<string, ApplicationRouteOwner>

function applicationRouteKey(route: ApplicationRoute): string {
	return JSON.stringify([route.kind, route.method, route.path])
}

function indexContributionRoutes(
	index: ApplicationRouteIndex,
	contribution: ApplicationContribution,
): void {
	for (const route of contribution.routes) {
		index.set(applicationRouteKey(route), { contribution, route })
	}
}

function unindexContributionRoutes(
	index: ApplicationRouteIndex,
	contribution: ApplicationContribution,
): void {
	for (const route of contribution.routes) {
		const key = applicationRouteKey(route)
		if (index.get(key)?.contribution === contribution) index.delete(key)
	}
}

function conflictingContribution(
	candidate: ApplicationContribution,
	index: ApplicationRouteIndex,
):
	| Readonly<{
			contribution: ApplicationContribution
			candidateRoute: ApplicationRoute
			existingRoute: ApplicationRoute
	  }>
	| undefined {
	for (const candidateRoute of candidate.routes) {
		const existing = index.get(applicationRouteKey(candidateRoute))
		if (!existing || existing.contribution.ctx === candidate.ctx) continue
		return Object.freeze({
			contribution: existing.contribution,
			candidateRoute,
			existingRoute: existing.route,
		})
	}
	return undefined
}

function assertNoRouteConflicts(contributions: readonly ApplicationContribution[]): void {
	const index: ApplicationRouteIndex = new Map()
	for (const contribution of contributions) {
		const conflict = conflictingContribution(contribution, index)
		if (conflict) {
			throw new Error(
				`[pluxel/runtime] Elysia route conflict for ${conflict.candidateRoute.method} ${conflict.candidateRoute.path} between "${conflict.contribution.ctx.pluginInfo.displayName}" and "${contribution.ctx.pluginInfo.displayName}"`,
			)
		}
		indexContributionRoutes(index, contribution)
	}
}

function buildApplicationSnapshot(
	contributions: readonly ApplicationContribution[],
): ApplicationSnapshot {
	const byOwnerKey = new Map(contributions.map((entry) => [entry.ownerKey, entry] as const))
	const httpSelectors = new Map<string, Elysia>()
	let webSocketSelector: Elysia | undefined
	for (const contribution of contributions) {
		for (const route of contribution.routes) {
			if (route.kind === 'websocket') {
				webSocketSelector ??= new Elysia({ name: 'pluxel.directory.websocket' })
				webSocketSelector.get(
					route.path,
					() =>
						new Response(null, {
							status: 204,
							headers: { [ROUTE_OWNER_HEADER]: contribution.ownerKey },
						}),
				)
				continue
			}

			let selector = httpSelectors.get(route.method)
			if (!selector) {
				selector = new Elysia({ name: `pluxel.directory.${route.method}` })
				httpSelectors.set(route.method, selector)
			}
			selector.all(
				route.path,
				() =>
					new Response(null, {
						status: 204,
						headers: { [ROUTE_OWNER_HEADER]: contribution.ownerKey },
					}),
			)
		}
	}
	for (const selector of httpSelectors.values()) selector.compile()
	webSocketSelector?.compile()
	return Object.freeze({ contributions, byOwnerKey, httpSelectors, webSocketSelector })
}

function selectWithElysia(
	snapshot: ApplicationSnapshot,
	selector: Elysia,
	request: Request,
): ApplicationContribution | undefined {
	const selected = selector.fetch(request)
	if (selected instanceof Promise) {
		throw new TypeError('[pluxel/runtime] Compiled Elysia directory selector became asynchronous')
	}
	const ownerKey = selected.headers.get(ROUTE_OWNER_HEADER)
	return ownerKey ? snapshot.byOwnerKey.get(ownerKey) : undefined
}

function selectHttpContribution(
	snapshot: ApplicationSnapshot,
	request: Request,
): ApplicationContribution | undefined {
	const method = request.method.toUpperCase()
	const methods = [method, WILDCARD_METHOD]
	for (const candidateMethod of methods) {
		const selector = snapshot.httpSelectors.get(candidateMethod)
		if (!selector) continue
		const selected = selectWithElysia(snapshot, selector, request)
		if (selected) return selected
	}
	return undefined
}

function selectWebSocketContribution(
	snapshot: ApplicationSnapshot,
	request: Request,
): ApplicationContribution | undefined {
	if (!snapshot.webSocketSelector) return undefined
	return selectWithElysia(snapshot, snapshot.webSocketSelector, request)
}

function isWebSocketUpgrade(request: Request): boolean {
	return request.headers.get('upgrade')?.toLowerCase() === 'websocket'
}

function isReservedRequest(request: Request): boolean {
	return isReservedPath(new URL(request.url).pathname)
}

function responseWithLease(response: Response, signal: AbortSignal, dispose: () => void): Response {
	if (!response.body) {
		dispose()
		return response
	}

	const reader = response.body.getReader()
	let released = false
	const release = () => {
		if (released) return
		released = true
		signal.removeEventListener('abort', abort)
		dispose()
	}
	const abort = () => {
		void reader
			.cancel(signal.reason)
			.catch((): undefined => undefined)
			.finally(release)
	}
	signal.addEventListener('abort', abort, { once: true })
	if (signal.aborted) abort()
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const result = await reader.read()
				if (result.done) {
					release()
					controller.close()
					return
				}
				controller.enqueue(result.value)
			} catch (error) {
				release()
				controller.error(error)
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason)
			} finally {
				release()
			}
		},
	})

	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
}

function requestWithSignal(request: Request, signal: AbortSignal): Request {
	const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
	return new Request(request.url, {
		method: request.method,
		headers: request.headers,
		signal,
		body: hasBody ? request.body : undefined,
		...(hasBody && request.body ? { duplex: 'half' } : {}),
	} as RequestInit)
}

/**
 * Runtime-private generation application registry and immutable business dispatcher.
 *
 * Elysia remains the authoring/runtime authority. This class only binds sealed application
 * generations to Core publication and owner admission.
 */
export class ElysiaApplicationDirectory {
	readonly lifecycleHooks: CorePluginLifecycleHooks

	private readonly applications = new WeakMap<PluginContext, Elysia>()
	private readonly serverViews = new WeakMap<PluginContext, OwnerElysiaServerView>()
	private readonly upgradeIngress = new WeakMap<Request, UpgradeIngress>()
	private readonly requestSources = new WeakMap<Request, Request>()
	private readonly pendingRequests = new Map<string, number>()
	private readonly staged = new Map<
		CoreGenerationFinalization['operation'],
		Map<PluginContext, ApplicationContribution>
	>()
	private readonly settled = new Map<
		CoreGenerationFinalization['operation'],
		Map<string, ApplicationContribution>
	>()
	private readonly prepared = new Map<
		CoreGenerationFinalization['operation'],
		PreparedApplicationPublication
	>()
	private snapshot: ApplicationSnapshot = EMPTY_SNAPSHOT
	private applicationCarrier: ElysiaApplicationCarrier | undefined

	constructor() {
		this.lifecycleHooks = Object.freeze({
			finalizeGeneration: (generation) => this.finalizeGeneration(generation),
			settleGenerations: (settlement) => this.settleGenerations(settlement),
			prepareCommit: (publication) => this.prepareCommit(publication),
			publishCommit: (publication) => this.publishCommit(publication),
		})
	}

	applicationFor(ctx: PluxelContext): Elysia {
		if (!ctx.pluginInfo) {
			throw new Error('[pluxel/runtime] ctx.elysia requires a Plugin generation Context')
		}
		const owner = ctx as PluginContext
		let app = this.applications.get(owner)
		if (app) return app
		const ownerKey = pluginNodeIndexKey(owner.pluginInfo.nodeAddress)
		app = new Elysia({
			adapter: PLUXEL_ELYSIA_ADAPTER,
			name: ctx.pluginInfo ? `pluxel.plugin.${ownerKey}` : 'pluxel.host',
		})
		const serverView = this.createServerView(owner, ownerKey, app)
		this.serverViews.set(owner, serverView)
		app.wrap((fetch) => async (request, ...rest) => {
			const lease = enterOwnerInvocation(owner, request.signal)
			const ownerRequest = requestWithSignal(request, lease.signal)
			this.requestSources.set(ownerRequest, request)
			this.incrementPendingRequest(ownerKey)
			let requestSettled = false
			const settleRequest = () => {
				if (requestSettled) return
				requestSettled = true
				this.decrementPendingRequest(ownerKey)
			}
			const ingress: UpgradeIngress = {
				request,
				ctx: owner,
				ownerKey,
				lease,
				settleRequest,
				transferred: false,
			}
			this.upgradeIngress.set(ownerRequest, ingress)
			try {
				const response = await fetch(ownerRequest, ...rest)
				if (ingress.transferred) return response
				if (!(response instanceof Response)) {
					throw new Error(
						'[pluxel/runtime] Elysia fetch returned no Response without transferring a WebSocket upgrade',
					)
				}
				return responseWithLease(response, lease.signal, () => {
					settleRequest()
					lease.dispose()
				})
			} catch (error) {
				if (!ingress.transferred) lease.dispose()
				settleRequest()
				throw error
			} finally {
				this.upgradeIngress.delete(ownerRequest)
			}
		})
		this.denyPhysicalApplicationLifecycle(app)
		this.applications.set(owner, app)
		return app
	}

	attachApplicationCarrier(carrier: ElysiaApplicationCarrier): () => void {
		if (this.applicationCarrier) {
			throw new Error('[pluxel/runtime] An Elysia application carrier is already attached')
		}
		this.applicationCarrier = carrier
		let active = true
		return () => {
			if (!active) return
			active = false
			if (this.applicationCarrier === carrier) this.applicationCarrier = undefined
		}
	}

	async dispatch(request: Request): Promise<Response | undefined> {
		if (isReservedRequest(request)) return undefined
		const contribution = isWebSocketUpgrade(request)
			? selectWebSocketContribution(this.snapshot, request)
			: selectHttpContribution(this.snapshot, request)
		if (!contribution) return undefined
		return contribution.app.fetch(request, contribution.serverView)
	}

	matchesHttpRoute(pathname: string, method?: string): boolean {
		const url = new URL(pathname, 'http://pluxel.invalid')
		if (isReservedPath(url.pathname)) return false
		if (method !== undefined) {
			return Boolean(
				selectHttpContribution(this.snapshot, new Request(url, { method: method.toUpperCase() })),
			)
		}
		for (const routeMethod of this.snapshot.httpSelectors.keys()) {
			if (selectHttpContribution(this.snapshot, new Request(url, { method: routeMethod }))) {
				return true
			}
		}
		return false
	}

	matchesWebSocketRoute(request: Request): boolean {
		return (
			!isReservedRequest(request) && Boolean(selectWebSocketContribution(this.snapshot, request))
		)
	}

	private createServerView(
		ctx: PluginContext,
		ownerKey: string,
		app: Elysia,
	): OwnerElysiaServerView {
		const readCarrier = () => this.applicationCarrier
		const pendingRequests = this.pendingRequests
		const virtualId = globalThis.crypto.randomUUID()
		const serverId = `pluxel:${virtualId}`
		const fallbackMetadata = Object.freeze({
			url: 'http://pluxel.invalid/',
			port: 0,
			hostname: 'pluxel.invalid',
			development: false,
		})
		const unsupported = (operation: string): never => {
			throw new Error(
				`[pluxel/runtime] ${operation} controls the shared physical carrier and is unavailable to a Plugin Elysia application`,
			)
		}
		let view: OwnerElysiaServerView
		view = {
			get id() {
				return serverId
			},
			get url() {
				return new URL(readCarrier()?.metadata.url.href ?? fallbackMetadata.url)
			},
			get port() {
				return readCarrier()?.metadata.port ?? fallbackMetadata.port
			},
			get hostname() {
				return readCarrier()?.metadata.hostname ?? fallbackMetadata.hostname
			},
			get development() {
				return readCarrier()?.metadata.development ?? fallbackMetadata.development
			},
			get pendingRequests() {
				return pendingRequests.get(ownerKey) ?? 0
			},
			get pendingWebSockets() {
				return readCarrier()?.pending(ownerKey) ?? 0
			},
			fetch: (request) => app.fetch(request, view),
			upgrade: (request, options = {}) => this.upgradeOwnerRequest(ctx, ownerKey, request, options),
			publish: (topic, data, compress) => {
				const carrier = this.applicationCarrier
				if (!carrier) return unsupported('server.publish()')
				return carrier.publish(ownerKey, topic, data, compress)
			},
			requestIP: (request) => {
				const carrier = this.applicationCarrier
				if (!carrier) return unsupported('server.requestIP()')
				const source = this.requestSources.get(request)
				if (!source) {
					return unsupported('server.requestIP() for a Request outside the active owner invocation')
				}
				return carrier.requestIP(source)
			},
			timeout: () => unsupported('server.timeout()'),
			stop: () => unsupported('server.stop()'),
			reload: () => unsupported('server.reload()'),
			ref: () => unsupported('server.ref()'),
			unref: () => unsupported('server.unref()'),
			[Symbol.dispose]: () => unsupported('server[Symbol.dispose]()'),
		}
		return Object.freeze(view)
	}

	private upgradeOwnerRequest(
		ctx: PluginContext,
		ownerKey: string,
		upgradeRequest: Request,
		options: { headers?: HeadersInit; data?: unknown },
	): boolean {
		const ingress = this.upgradeIngress.get(upgradeRequest)
		if (!ingress || ingress.ctx !== ctx || ingress.ownerKey !== ownerKey) return false
		const carrier = this.applicationCarrier
		if (!carrier) return false

		const input: ElysiaWebSocketUpgrade = Object.freeze({
			request: ingress.request,
			upgradeRequest,
			ownerKey,
			...(options.headers === undefined ? {} : { headers: options.headers }),
			data: options.data,
			signal: ingress.lease.signal,
			release: () => ingress.lease.dispose(),
		})
		const accepted = carrier.upgrade(input)
		if (!accepted) return false
		ingress.transferred = true
		ingress.settleRequest()
		return true
	}

	private denyPhysicalApplicationLifecycle(app: Elysia): void {
		const physicalUnavailable = (operation: string) => () => {
			throw new Error(
				`[pluxel/runtime] app.${operation}() controls the shared physical carrier and is unavailable to a Plugin Elysia application`,
			)
		}
		const externalEpochUnavailable = (operation: 'setup' | 'cleanup') => () => {
			throw new Error(
				`[pluxel/runtime] app.${operation}() is unsupported because Elysia 2 beta.7 exposes no public external application attach/detach epoch`,
			)
		}
		Object.defineProperties(app, {
			setup: {
				value: externalEpochUnavailable('setup'),
				writable: false,
				configurable: false,
			},
			cleanup: {
				value: externalEpochUnavailable('cleanup'),
				writable: false,
				configurable: false,
			},
			listen: {
				value: physicalUnavailable('listen'),
				writable: false,
				configurable: false,
			},
			stop: {
				value: physicalUnavailable('stop'),
				writable: false,
				configurable: false,
			},
		})
	}

	private incrementPendingRequest(ownerKey: string): void {
		this.pendingRequests.set(ownerKey, (this.pendingRequests.get(ownerKey) ?? 0) + 1)
	}

	private decrementPendingRequest(ownerKey: string): void {
		const next = (this.pendingRequests.get(ownerKey) ?? 1) - 1
		if (next > 0) this.pendingRequests.set(ownerKey, next)
		else this.pendingRequests.delete(ownerKey)
	}

	private async finalizeGeneration(generation: CoreGenerationFinalization): Promise<void> {
		const app = this.applications.get(generation.ctx)
		if (!app) return
		if (generation.signal.aborted) throw generation.signal.reason

		try {
			await app.modules
			if (generation.signal.aborted) throw generation.signal.reason
			const routes = applicationRoutes(app)
			assertApplicationRoutesAvailable(generation.ctx, routes)
			const serverView = this.serverViews.get(generation.ctx)
			if (!serverView) {
				throw new Error('[pluxel/runtime] Elysia owner Server view was not created')
			}
			Object.defineProperty(app, 'server', {
				value: serverView,
				writable: false,
				configurable: false,
				enumerable: true,
			})
			app.compile()
			let operation = this.staged.get(generation.operation)
			if (!operation) {
				operation = new Map()
				this.staged.set(generation.operation, operation)
			}
			operation.set(
				generation.ctx,
				Object.freeze({
					ctx: generation.ctx,
					ownerKey: pluginNodeIndexKey(generation.ctx.pluginInfo.nodeAddress),
					app,
					serverView,
					routes,
				}),
			)
		} catch (error) {
			this.staged.get(generation.operation)?.delete(generation.ctx)
			throw error
		}
	}

	private settleGenerations(
		settlement: CoreGenerationSettlement,
	): readonly CoreGenerationRejection[] | undefined {
		const stopped = new Set(settlement.stopped)
		const working = new Map<string, ApplicationContribution>()
		for (const contribution of this.snapshot.contributions) {
			if (!stopped.has(contribution.ctx)) working.set(contribution.ownerKey, contribution)
		}
		const accepted = this.settled.get(settlement.operation) ?? new Map()
		for (const contribution of accepted.values()) {
			if (!stopped.has(contribution.ctx)) working.set(contribution.ownerKey, contribution)
		}
		const routeIndex: ApplicationRouteIndex = new Map()
		for (const contribution of working.values()) {
			indexContributionRoutes(routeIndex, contribution)
		}

		const candidates = this.staged.get(settlement.operation)
		const rejections: CoreGenerationRejection[] = []
		for (const ctx of settlement.started) {
			const candidate = candidates?.get(ctx)
			if (!candidate) continue
			const replaced = working.get(candidate.ownerKey)
			if (replaced) unindexContributionRoutes(routeIndex, replaced)
			working.delete(candidate.ownerKey)
			const conflict = conflictingContribution(candidate, routeIndex)
			if (conflict) {
				rejections.push(
					Object.freeze({
						ctx,
						error: new Error(
							`[pluxel/runtime] Elysia route conflict for ${conflict.candidateRoute.method} ${conflict.candidateRoute.path}; "${conflict.contribution.ctx.pluginInfo.displayName}" already owns the same route`,
						),
					}),
				)
				continue
			}
			working.set(candidate.ownerKey, candidate)
			indexContributionRoutes(routeIndex, candidate)
			accepted.set(candidate.ownerKey, candidate)
		}
		this.settled.set(settlement.operation, accepted)
		return rejections.length > 0 ? Object.freeze(rejections) : undefined
	}

	private prepareCommit(publication: CoreCommitPublication): void {
		const next = new Map(this.snapshot.contributions.map((entry) => [entry.ctx, entry] as const))
		for (const ctx of publication.stopped) next.delete(ctx)
		const candidates = this.staged.get(publication.operation)
		for (const ctx of publication.started) {
			const candidate = candidates?.get(ctx)
			if (candidate) next.set(ctx, candidate)
		}

		const contributions = Object.freeze(
			[...next.values()].sort((left, right) => left.ownerKey.localeCompare(right.ownerKey)),
		)
		assertNoRouteConflicts(contributions)
		const unchanged =
			contributions.length === this.snapshot.contributions.length &&
			contributions.every((entry, index) => entry === this.snapshot.contributions[index])
		this.prepared.set(
			publication.operation,
			Object.freeze({
				publication,
				snapshot: unchanged ? this.snapshot : buildApplicationSnapshot(contributions),
			}),
		)
	}

	private publishCommit(publication: CoreCommitPublication): undefined {
		const prepared = this.prepared.get(publication.operation)
		if (!prepared || prepared.publication !== publication) {
			throw new Error('[pluxel/runtime] Elysia application publication was not prepared')
		}
		this.snapshot = prepared.snapshot
		this.prepared.delete(publication.operation)
		this.staged.delete(publication.operation)
		this.settled.delete(publication.operation)
		return undefined
	}
}
