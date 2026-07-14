import { readFile, stat } from 'node:fs/promises'
import { extname } from 'pathe'
import type { AnyElysiaApp } from '../../services/http/elysia'
import { requireManagement } from '../../services/management'
import { MANAGEMENT_FEDERATION_MANIFEST_FILE } from '../../management/federation'
import { signalDbNamespace } from '../../management/collection-contracts'
import {
	RUNTIME_INTERNAL_API_BASE,
	RUNTIME_MANAGEMENT_BASE,
	RUNTIME_MANAGEMENT_COLLECTION_EVENTS_PATH,
	runtimeManagementArtifactBasePath,
} from '../../web/paths'

export const managementRoutes = (app: AnyElysiaApp) =>
	app.group(RUNTIME_MANAGEMENT_BASE, (management) =>
		management
			.get('/catalog', ({ pluginCtx, set }) => {
				set.headers['cache-control'] = 'no-store'
				return requireManagement(pluginCtx).registry.getCatalog()
			})
			.get('/layout/global', ({ pluginCtx, set }) => {
				set.headers['cache-control'] = 'no-store'
				return requireManagement(pluginCtx).registry.getGlobalLayout()
			})
			.get('/layout/plugin/:target', ({ params, pluginCtx, set }) => {
				set.headers['cache-control'] = 'no-store'
				return requireManagement(pluginCtx).registry.getPluginLayout(
					decodeURIComponent(params.target),
				)
			})
			.get('/artifacts/:owner/:hash/*', async ({ params, pluginCtx, request, status }) => {
				const backend = requireManagement(pluginCtx)
				const owner = decodeURIComponent(params.owner)
				const sourceHash = decodeURIComponent(params.hash)
				const file = extractArtifactFilePath(request.url, owner, sourceHash)
				if (!file) return status(400, 'Invalid artifact path')
				const fullPath = backend.artifacts.resolveArtifactFile(owner, sourceHash, file)
				if (!fullPath) return status(404, 'Artifact not found')
				const fileStat = await stat(fullPath).catch((): null => null)
				if (!fileStat?.isFile()) return status(404, 'Artifact not found')
				const body = await readFile(fullPath).catch((): null => null)
				if (!body) return status(404, 'Artifact not found')
				if (file === MANAGEMENT_FEDERATION_MANIFEST_FILE) {
					return new Response(
						rewriteFederationManifest(body.toString('utf-8'), owner, sourceHash),
						{
							headers: {
								'content-type': 'application/json; charset=utf-8',
								'cache-control': 'public, max-age=31536000, immutable',
							},
						},
					)
				}
				return new Response(body, {
					headers: {
						'content-type': contentTypeForFile(fullPath),
						'cache-control': 'public, max-age=31536000, immutable',
					},
				})
			})
			.get('/events', (context) =>
				requireManagement(context.pluginCtx).streams.stream(context, ['management.layouts']),
			)
			.get(
				RUNTIME_MANAGEMENT_COLLECTION_EVENTS_PATH.slice(RUNTIME_MANAGEMENT_BASE.length),
				(context) => {
					const backend = requireManagement(context.pluginCtx)
					const bindings = [
						...new Set(
							new URL(context.request.url).searchParams
								.getAll('binding')
								.map((binding) => binding.trim())
								.filter(Boolean),
						),
					]
					if (bindings.length === 0) return context.status(400, 'Collection binding required')
					const subscriptions = bindings.flatMap((binding) => {
						const ref = backend.registry.findResource(binding, 'collection')
						if (!ref) {
							// A revision can leave warm client replicas with expired bindings for a
							// short grace period. Ignore only those aliases so fresh bindings are not
							// blocked; an all-invalid request still receives no stream.
							return []
						}
						return [
							{
								alias: binding,
								namespace: signalDbNamespace(ref.owner, ref.resource),
							},
						]
					})
					if (subscriptions.length === 0) {
						return context.status(404, 'Collection binding invalid or expired')
					}
					return backend.streams.streamWithAliases(context, subscriptions)
				},
			)
			.get('/resources/stream/:binding', (context) => {
				const backend = requireManagement(context.pluginCtx)
				const ref = backend.registry.resolveResource(decodeURIComponent(context.params.binding))
				if (ref.kind === 'api') return context.status(400, 'API bindings are not streams')
				const namespace =
					ref.kind === 'collection'
						? signalDbNamespace(ref.owner, ref.resource)
						: `${ref.owner}:${ref.resource}`
				return backend.streams.stream(context, [namespace])
			}),
	)

function extractArtifactFilePath(url: string, owner: string, sourceHash: string): string | null {
	const pathname = new URL(url).pathname
	const artifactBase = runtimeManagementArtifactBasePath(owner, sourceHash)
	const fullPrefix = `${RUNTIME_INTERNAL_API_BASE}${artifactBase}`
	const prefix = pathname.startsWith(fullPrefix) ? fullPrefix : artifactBase
	if (!pathname.startsWith(prefix)) return null
	const file = pathname.slice(prefix.length).replace(/^\/+/, '')
	return file || null
}

function contentTypeForFile(path: string): string {
	switch (extname(path).toLowerCase()) {
		case '.js':
		case '.mjs':
			return 'application/javascript; charset=utf-8'
		case '.css':
			return 'text/css; charset=utf-8'
		case '.json':
		case '.map':
			return 'application/json; charset=utf-8'
		case '.svg':
			return 'image/svg+xml'
		case '.png':
			return 'image/png'
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg'
		case '.woff':
			return 'font/woff'
		case '.woff2':
			return 'font/woff2'
		default:
			return 'application/octet-stream'
	}
}

function rewriteFederationManifest(raw: string, owner: string, sourceHash: string): string {
	try {
		const manifest = JSON.parse(raw)
		const publicPath = `${RUNTIME_INTERNAL_API_BASE}${runtimeManagementArtifactBasePath(owner, sourceHash)}/`
		if (manifest?.metaData && typeof manifest.metaData === 'object') {
			manifest.metaData.publicPath = publicPath
			if ('getPublicPath' in manifest.metaData) delete manifest.metaData.getPublicPath
		}
		return JSON.stringify(manifest)
	} catch {
		return raw
	}
}
