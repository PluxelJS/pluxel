import type { ExtensionManifest } from '@pluxel/runtime/web/extensions'
import { getRuntimeTransportClient } from '../../runtime'

export async function fetchExtensionManifest(init?: RequestInit): Promise<ExtensionManifest> {
	return getRuntimeTransportClient().http.extensions.manifest(init)
}
