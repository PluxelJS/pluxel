import { createAuthAwareFetch, HMR_INTERNAL_API_BASE } from '@pluxel/hmr-web'
import type { ExtensionManifest } from '../types'

export const EXTENSION_MANIFEST_ENDPOINT = `${HMR_INTERNAL_API_BASE}/extensions/manifest`

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
