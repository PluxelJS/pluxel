import type { Context } from '@pluxel/core'
import { requireWorkbench } from './services/workbench'

const ARTIFACT_BASE = '/__pluxel/runtime/federation/'

/** Borrowed Fetch handler over the committed immutable producer inventory. Authenticate in the carrier. */
export function createWorkbenchArtifactHandler(
	root: Context,
): (request: Request) => Promise<Response | undefined> {
	const backend = requireWorkbench(root)
	return async (request) => {
		const pathname = new URL(request.url).pathname
		if (!pathname.startsWith(ARTIFACT_BASE)) return undefined
		if (request.method !== 'GET' && request.method !== 'HEAD')
			return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
		const [producerPart, revisionPart, ...fileParts] = pathname
			.slice(ARTIFACT_BASE.length)
			.split('/')
		if (!producerPart || !revisionPart || !fileParts.join('/'))
			return new Response('Invalid federation artifact path', { status: 400 })
		let producer: string, revision: string
		try {
			producer = decodeURIComponent(producerPart)
			revision = decodeURIComponent(revisionPart)
		} catch {
			return new Response('Invalid federation artifact path', { status: 400 })
		}
		const artifact = await backend.artifacts.readArtifactFile(
			producer,
			revision,
			fileParts.join('/'),
		)
		if (!artifact) return new Response('Federation artifact not found', { status: 404 })
		const headers = {
			'content-type': artifact.contentType,
			'cache-control': 'private, max-age=31536000, immutable',
			'content-security-policy': "default-src 'none'",
			'x-content-type-options': 'nosniff',
			etag: artifact.etag,
		}
		if (request.headers.get('if-none-match') === artifact.etag)
			return new Response(null, { status: 304, headers })
		return new Response(request.method === 'HEAD' ? null : Buffer.from(artifact.body), { headers })
	}
}
