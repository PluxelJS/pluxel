import { readFile, stat } from 'node:fs/promises'
import { extname } from 'pathe'
import type { AnyElysiaApp } from '../../services/http/elysia'
import { EXTENSION_FEDERATION_MANIFEST_FILE } from '../../web/federation'
import {
	HMR_EXTENSIONS_BASE,
	HMR_INTERNAL_API_BASE,
	hmrExtensionArtifactBasePath,
} from '../../web/paths'

export const extensionRoutes = (app: AnyElysiaApp) =>
	app.group(HMR_EXTENSIONS_BASE, (extensions) =>
		extensions
			.get('/manifest', ({ set, pluginCtx }) => {
				const extensionService = pluginCtx.ext.ui
				if (!extensionService) {
					return {
						version: 0,
						modules: [],
						builtins: [],
						surfaces: [],
						offers: [],
						sessions: [],
						interactions: [],
						states: [],
					}
				}
				set.headers['cache-control'] = 'no-store'
				return extensionService.getManifest()
			})
			.get('/artifacts/:plugin/:hash/*', async ({ params, pluginCtx, request, status }) => {
				const extensionService = pluginCtx.ext.ui
				if (!extensionService) {
					return status(503, 'Extension service not available')
				}

				const pluginName = decodeURIComponent(params.plugin)
				const sourceHash = decodeURIComponent(params.hash)
				const file = extractArtifactFilePath(request.url, pluginName, sourceHash)
				if (!file) {
					return status(400, 'Invalid artifact path')
				}

				const fullPath = extensionService.resolveArtifactFile(pluginName, sourceHash, file)
				if (!fullPath) {
					return status(404, 'Artifact not found')
				}

				const fileStat = await stat(fullPath).catch((): null => null)
				if (!fileStat?.isFile()) {
					return status(404, 'Artifact not found')
				}

				const body = await readFile(fullPath).catch((): null => null)
				if (!body) {
					return status(404, 'Artifact not found')
				}

				if (file === EXTENSION_FEDERATION_MANIFEST_FILE) {
					return new Response(
						rewriteFederationManifest(body.toString('utf-8'), pluginName, sourceHash),
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
			.get('/events', (context) => context.pluginCtx.ext.sse.stream(context, ['extensions'])),
	)

function extractArtifactFilePath(
	url: string,
	pluginName: string,
	sourceHash: string,
): string | null {
	const pathname = new URL(url).pathname
	const prefix = `${HMR_INTERNAL_API_BASE}${hmrExtensionArtifactBasePath(pluginName, sourceHash)}`
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
			return 'application/json; charset=utf-8'
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

function rewriteFederationManifest(raw: string, pluginName: string, sourceHash: string): string {
	try {
		const manifest = JSON.parse(raw)
		const publicPath = `${HMR_INTERNAL_API_BASE}${hmrExtensionArtifactBasePath(pluginName, sourceHash)}/`
		if (manifest?.metaData && typeof manifest.metaData === 'object') {
			manifest.metaData.publicPath = publicPath
			if ('getPublicPath' in manifest.metaData) {
				delete manifest.metaData.getPublicPath
			}
		}
		return JSON.stringify(manifest)
	} catch {
		return raw
	}
}
