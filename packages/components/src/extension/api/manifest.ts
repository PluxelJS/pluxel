import type { ExtensionManifest } from '../types'

export const EXTENSION_MANIFEST_ENDPOINT = '/api/extensions/manifest'

export async function fetchExtensionManifest(init?: RequestInit): Promise<ExtensionManifest> {
	const response = await fetch(EXTENSION_MANIFEST_ENDPOINT, {
		cache: 'no-store',
		credentials: 'same-origin',
		...init,
	})

	if (!response.ok) {
		throw new Error('Failed to fetch extension manifest')
	}

	return response.json() as Promise<ExtensionManifest>
}
