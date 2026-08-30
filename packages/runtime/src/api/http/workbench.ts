import type { AnyHostElysiaApp } from '../../services/http/elysia'
import { requireWorkbench } from '../../services/workbench'
import { RUNTIME_WORKBENCH_FEDERATION_BASE } from '../../web/paths'

/** Standard immutable MF files are Workbench's only ordinary HTTP surface. */
export const workbenchRoutes = (app: AnyHostElysiaApp) =>
	app.group(RUNTIME_WORKBENCH_FEDERATION_BASE, (federation) =>
		federation.get('/:producer/:revision/*', async ({ params, pluginCtx, request, status }) => {
			const file = artifactFileFromRequest(request.url, params.producer, params.revision)
			if (!file) return status(400, 'Invalid federation artifact path')
			const artifact = await requireWorkbench(pluginCtx).artifacts.readArtifactFile(
				params.producer,
				params.revision,
				file,
			)
			if (!artifact) return status(404, 'Federation artifact not found')
			if (request.headers.get('if-none-match') === artifact.etag) {
				return new Response(null, {
					status: 304,
					headers: immutableHeaders(artifact.contentType, artifact.etag),
				})
			}
			return new Response(Buffer.from(artifact.body), {
				headers: immutableHeaders(artifact.contentType, artifact.etag),
			})
		}),
	)

function artifactFileFromRequest(
	requestUrl: string,
	producer: string,
	revision: string,
): string | null {
	let canonicalProducer: string
	let canonicalRevision: string
	try {
		canonicalProducer = decodeURIComponent(producer)
		canonicalRevision = decodeURIComponent(revision)
	} catch {
		return null
	}
	const pathname = new URL(requestUrl).pathname
	const marker = `${RUNTIME_WORKBENCH_FEDERATION_BASE}/${encodeURIComponent(canonicalProducer)}/${encodeURIComponent(canonicalRevision)}/`
	const index = pathname.indexOf(marker)
	if (index < 0) return null
	const file = pathname.slice(index + marker.length)
	return file || null
}

function immutableHeaders(contentType: string, etag: string): HeadersInit {
	return {
		'content-type': contentType,
		'cache-control': 'private, max-age=31536000, immutable',
		'content-security-policy': "default-src 'none'",
		'x-content-type-options': 'nosniff',
		etag,
	}
}
