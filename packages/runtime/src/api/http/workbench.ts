import { readFile, stat } from 'node:fs/promises'
import { extname } from 'pathe'
import type { AnyElysiaApp } from '../../services/http/elysia'
import { requireWorkbench } from '../../services/workbench'
import { WORKBENCH_FEDERATION_MANIFEST_FILE } from '@pluxel/core/federation'
import { parsePluginNodeAddress } from '@pluxel/core'
import {
	RUNTIME_INTERNAL_API_BASE,
	RUNTIME_WORKBENCH_BASE,
	runtimeWorkbenchArtifactBasePath,
} from '../../web/paths'

export const workbenchRoutes = (app: AnyElysiaApp) =>
	app.group(RUNTIME_WORKBENCH_BASE, (workbench) =>
		workbench
			.get('/catalog', ({ pluginCtx, set }) => {
				set.headers['cache-control'] = 'no-store'
				return requireWorkbench(pluginCtx).registry.getCatalog()
			})
			.get('/layout/global', ({ pluginCtx, set }) => {
				set.headers['cache-control'] = 'no-store'
				return requireWorkbench(pluginCtx).registry.getGlobalLayout()
			})
			.get('/layout/plugin', ({ query, pluginCtx, set }) => {
				set.headers['cache-control'] = 'no-store'
				return requireWorkbench(pluginCtx).registry.getPluginLayout(
					parsePluginNodeAddress(JSON.parse(String(query.target)) as unknown),
				)
			})
			.get('/artifacts/:owner/:hash/*', async ({ params, pluginCtx, request, status }) => {
				const backend = requireWorkbench(pluginCtx)
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
				if (file === WORKBENCH_FEDERATION_MANIFEST_FILE) {
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
				requireWorkbench(context.pluginCtx).events.stream(context, ['workbench.layouts']),
			)
			.get('/models/events/:grantId', (context) => {
				const backend = requireWorkbench(context.pluginCtx)
				const ref = backend.registry.resolveModel(decodeURIComponent(context.params.grantId))
				if (ref.kind !== 'events' && ref.kind !== 'liveQuery') {
					return context.status(400, 'Resource does not expose an event stream')
				}
				return backend.events.stream(context, [ref.resourceId])
			}),
	)

function extractArtifactFilePath(url: string, owner: string, sourceHash: string): string | null {
	const pathname = new URL(url).pathname
	const artifactBase = runtimeWorkbenchArtifactBasePath(owner, sourceHash)
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
		const publicPath = `${RUNTIME_INTERNAL_API_BASE}${runtimeWorkbenchArtifactBasePath(owner, sourceHash)}/`
		if (manifest?.metaData && typeof manifest.metaData === 'object') {
			manifest.metaData.publicPath = publicPath
			if ('getPublicPath' in manifest.metaData) delete manifest.metaData.getPublicPath
		}
		return JSON.stringify(manifest)
	} catch {
		return raw
	}
}
