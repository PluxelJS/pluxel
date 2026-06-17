import type { Context as PluginContext } from '@pluxel/core'
import type { Changeset, LoadResponse } from '@signaldb/core'
import {
	canAccessSecurityAdmin,
	createVerificationBlockedHeaders,
	createVerificationBlockedPayload,
	resolveControlPlaneRedirectPath,
} from '../../shared/verification-http'
import {
	HMR_INTERNAL_API_BASE,
	HMR_SECURITY_BASE,
	HMR_TRANSPORT_PATHS,
} from '../../web/paths'
import { buildVerificationRedirectPath } from '../verification/transport'
import { newHttpBatchRpcResponse } from 'capnweb'

import { extensionRoutes } from '../../api/http/extensions'
import { metaRoutes } from '../../api/http/meta'
import { securityRoutes } from '../../api/http/security'
import { debugRoutes } from '../../api/http/debug'
import { logRoutes } from '../../api/http/logs'
import { pluginNameParams } from '../../api/http/models'
import { RuntimeRpcApi } from '../../api/http/rpc/RuntimeRpcApi'
import { pluginSchema } from '../../api/usecases/pluginConfig'
import type { SignalDbItem } from '../../web/plugin-ui/signaldb-contracts'
import { getRuntimePluginCatalog } from '../runtime/catalog/RuntimePluginCatalogService'
import { SignalDbService } from '../plugin-interaction/SignalDbService'
import type { ElysiaBoundaryBuilder } from './HttpService'
import { createElysiaApp } from './elysia'

type BaseElysiaApp = any
type InternalApiOptions = {
	web?: boolean
	rpc?: boolean
	sse?: boolean
}

type SignalDbPushBody<T extends SignalDbItem = SignalDbItem> = {
	changes: Changeset<T>
}

function resolveRequestKind(path: string): 'api' | 'graphql' {
	return path === `${HMR_INTERNAL_API_BASE}${HMR_TRANSPORT_PATHS.graphql}` ? 'graphql' : 'api'
}

function isSecurityApiPath(path: string): boolean {
	return (
		path === `${HMR_INTERNAL_API_BASE}${HMR_SECURITY_BASE}` ||
		path.startsWith(`${HMR_INTERNAL_API_BASE}${HMR_SECURITY_BASE}/`)
	)
}

function createInternalPlugin(
	ctx: PluginContext,
	name: string,
	build: (app: BaseElysiaApp) => unknown,
): BaseElysiaApp {
	const app = createElysiaApp(ctx, {
		aot: true,
		name: `pluxel.http.internal.${name}`,
	}) as unknown as BaseElysiaApp
	return build(app) as unknown as BaseElysiaApp
}

function applyInternalApiGuard(app: BaseElysiaApp): BaseElysiaApp {
	return app.onBeforeHandle(async ({ pluginCtx, request, set, status }: any) => {
		const path = new URL(request.url).pathname
		const method = (request.method ?? 'GET').toUpperCase()
		const state = pluginCtx.root.verification.authorize({ request })

		if (isSecurityApiPath(path)) {
			if (canAccessSecurityAdmin(state)) return undefined
			const redirectPath = resolveControlPlaneRedirectPath(
				buildVerificationRedirectPath,
				request,
				'api',
				state.reason,
			)
			Object.assign(set.headers, createVerificationBlockedHeaders(redirectPath, state.reason))
			return status(
				401,
				createVerificationBlockedPayload(path, method, 'api', redirectPath, state.reason),
			)
		}

		const validation = pluginCtx.internalApiValidation
		if (validation?.hasValidators()) {
			const result = await validation.check({
				path,
				method,
				url: request.url,
				headers: request.headers,
				request,
			})
			if (result.allow !== true) {
				set.headers['cache-control'] = 'no-store'
				set.headers['x-pluxel-internal-blocked'] = '1'
				pluginCtx.logger.warn('Blocked internal API request (validation)', {
					path,
					method,
					pluginName: result.pluginName,
				})

				return status(403, {
					allow: false,
					code: 'internal_api_blocked',
					path,
					method,
					pluginName: result.pluginName,
				})
			}
		}

		const kind = resolveRequestKind(path)
		if (state.allow) return undefined

		const redirectPath = resolveControlPlaneRedirectPath(
			buildVerificationRedirectPath,
			request,
			kind,
			state.reason,
		)
		pluginCtx.logger.warn('Blocked host verification gate', {
			kind,
			path,
			method,
			reason: state.reason,
		})

		Object.assign(set.headers, createVerificationBlockedHeaders(redirectPath, state.reason))
		return status(
			401,
			createVerificationBlockedPayload(path, method, kind, redirectPath, state.reason),
		)
	}) as BaseElysiaApp
}

function createInternalTransportPlugins(
	ctx: PluginContext,
	options: InternalApiOptions = {},
): BaseElysiaApp[] {
	const web = options.web !== false
	const rpc = options.rpc !== false
	const sse = options.sse !== false
	const plugins: BaseElysiaApp[] = [
		createInternalPlugin(ctx, 'root', (app) => app.get('/', 'Pluxel HMR RPC ready')),
		createInternalPlugin(ctx, 'plugin-schema', (app) =>
			app.get(
				'/plugins/:name/schema',
				async ({ pluginCtx, params }: any) => await pluginSchema(pluginCtx, params.name),
				{
					params: pluginNameParams,
				},
			),
		),
	]

	if (sse) {
		plugins.push(
			createInternalPlugin(ctx, 'sse', (app) =>
				app.get(HMR_TRANSPORT_PATHS.sse, (context: any) =>
					context.pluginCtx.ext.sse.stream(context),
				),
			),
		)
	}
	if (rpc) {
		plugins.push(
			createInternalPlugin(ctx, 'rpc', (app) =>
				app.all(
					HMR_TRANSPORT_PATHS.rpc,
					async ({ pluginCtx, request, status }: any) => {
						try {
							return await newHttpBatchRpcResponse(request, new RuntimeRpcApi(pluginCtx))
						} catch (error) {
							pluginCtx.logger.error('RPC request failed', { error })
							return status(500, 'Internal RPC error')
						}
					},
					{ parse: 'none' },
				),
			),
			ctx.internalGraphql.plugin(),
		)
	}
	if (web || rpc || sse) {
		plugins.push(
			createInternalPlugin(ctx, 'signaldb', (app) =>
				app
					.get(
						`${HMR_TRANSPORT_PATHS.signaldb}/:plugin/:collection`,
						async ({ params, pluginCtx, set }: any) => {
							set.headers['cache-control'] = 'no-store'
							return await loadSignalDbSnapshot(
								pluginCtx,
								decodePathParam(params.plugin),
								decodePathParam(params.collection),
							)
						},
					)
					.post(
						`${HMR_TRANSPORT_PATHS.signaldb}/:plugin/:collection`,
						async ({ params, pluginCtx, request, set, status }: any) => {
							set.headers['cache-control'] = 'no-store'
							const body = await request.json().catch((): null => null)
							const changes = readSignalDbChanges(body)
							if (!changes) {
								return status(400, {
									ok: false,
									code: 'invalid_signaldb_changes',
								})
							}

							const result = await pushSignalDbChanges(
								pluginCtx,
								decodePathParam(params.plugin),
								decodePathParam(params.collection),
								changes,
							)

							if (result === 'missing') {
								return status(409, {
									ok: false,
									code: 'signaldb_unavailable',
								})
							}
							if (result === 'readonly') {
								return status(403, {
									ok: false,
									code: 'signaldb_readonly',
								})
							}

							return { ok: true }
						},
						{ parse: 'none' },
					),
			),
			createInternalPlugin(ctx, 'meta', (app) =>
				metaRoutes(app as unknown as Parameters<typeof metaRoutes>[0]),
			),
			createInternalPlugin(ctx, 'security', (app) =>
				securityRoutes(app as unknown as Parameters<typeof securityRoutes>[0]),
			),
			createInternalPlugin(ctx, 'debug', (app) =>
				debugRoutes(app as unknown as Parameters<typeof debugRoutes>[0]),
			),
			createInternalPlugin(ctx, 'logs', (app) =>
				logRoutes(app as unknown as Parameters<typeof logRoutes>[0]),
			),
		)
	}
	if (web) {
		plugins.push(
			createInternalPlugin(ctx, 'extensions', (app) =>
				extensionRoutes(app as unknown as Parameters<typeof extensionRoutes>[0]),
			),
		)
	}

	return plugins
}

export function createInternalApiPlugin(
	ctx: PluginContext,
	options: InternalApiOptions = {},
): BaseElysiaApp {
	let app = applyInternalApiGuard(
		createElysiaApp(ctx, {
			aot: true,
			name: 'pluxel.http.internal',
		}) as unknown as BaseElysiaApp,
	)

	for (const plugin of createInternalTransportPlugins(ctx, options))
		app = app.use(plugin) as BaseElysiaApp

	return app
}

export function createInternalApiRoutes(
	ctx: PluginContext,
	options: InternalApiOptions = {},
): ElysiaBoundaryBuilder {
	return () => createInternalApiPlugin(ctx, options)
}

function decodePathParam(value: unknown): string {
	try {
		return decodeURIComponent(String(value ?? '').trim())
	} catch {
		return String(value ?? '').trim()
	}
}

async function loadSignalDbSnapshot<T extends SignalDbItem>(
	ctx: PluginContext,
	pluginName: string,
	collectionName: string,
): Promise<LoadResponse<T>> {
	const service = resolveSignalDbService(ctx, pluginName)
	if (!service) return { items: [] }
	return await service.loadCollectionSync<T>(collectionName)
}

async function pushSignalDbChanges<T extends SignalDbItem>(
	ctx: PluginContext,
	pluginName: string,
	collectionName: string,
	changes: Changeset<T>,
): Promise<'applied' | 'readonly' | 'missing'> {
	const service = resolveSignalDbService(ctx, pluginName)
	if (!service) return 'missing'
	return await service.applyCollectionSyncChanges(collectionName, changes)
}

function resolveSignalDbService(ctx: PluginContext, pluginName: string): SignalDbService | null {
	const ctor = getRuntimePluginCatalog(ctx).resolveOrRegistered(pluginName)
	if (!ctor) return null

	const instance = ctx.registry.getInstance(ctor as never) as
		| {
				ctx?: {
					ext?: {
						signaldb?: unknown
					}
				}
		  }
		| undefined
	const signaldb = instance?.ctx?.ext?.signaldb
	if (!signaldb || typeof signaldb !== 'object') return null
	if (
		typeof (signaldb as SignalDbService).loadCollectionSync !== 'function' ||
		typeof (signaldb as SignalDbService).applyCollectionSyncChanges !== 'function'
	) {
		return null
	}
	return signaldb as SignalDbService
}

function readSignalDbChanges(body: unknown): Changeset<SignalDbItem> | null {
	if (!body || typeof body !== 'object') return null
	const changes = (body as SignalDbPushBody<SignalDbItem>).changes
	if (!changes || typeof changes !== 'object') return null

	return {
		added: sanitizeSignalDbItems(changes.added),
		modified: sanitizeSignalDbItems(changes.modified),
		removed: sanitizeSignalDbItems(changes.removed),
	}
}

function sanitizeSignalDbItems<T extends SignalDbItem>(items: readonly T[] | undefined): T[] {
	if (!Array.isArray(items)) return []
	return items
		.filter((item): item is T => !!item && typeof item.id === 'string' && item.id.length > 0)
		.map((item) => cloneSignalDbItem(item))
}

function cloneSignalDbItem<T>(item: T): T {
	return item && typeof item === 'object' ? ({ ...(item as Record<string, unknown>) } as T) : item
}
