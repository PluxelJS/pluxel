import type { ExtensionManifest } from '../types'
import { createAuthAwareFetch } from '@pluxel/hmr-web'

export const EXTENSION_MANIFEST_ENDPOINT = '/api/extensions/manifest'

const baseFetch =
	typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined

export async function fetchExtensionManifest(init?: RequestInit): Promise<ExtensionManifest> {
	if (!baseFetch) {
		throw new Error('[pluxel/components] global fetch is unavailable')
	}
	const authFetch = createAuthAwareFetch(baseFetch)

	const response = await authFetch(EXTENSION_MANIFEST_ENDPOINT, {
		cache: 'no-store',
		credentials: 'same-origin',
		...init,
	})

	if (!response.ok) {
		throw new Error('Failed to fetch extension manifest')
	}

	return response.json() as Promise<ExtensionManifest>
}
