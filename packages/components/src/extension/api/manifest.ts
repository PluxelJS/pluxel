import type { ExtensionManifest } from '@pluxel/runtime/web/extensions'
import { getHmrWebClient } from '../../hmr/client'

export async function fetchExtensionManifest(init?: RequestInit): Promise<ExtensionManifest> {
	return getHmrWebClient().api.extensions.manifest(init)
}
