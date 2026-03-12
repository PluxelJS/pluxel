import type { ExtensionManifest } from '../types'
import { getHmrWebClient } from '../../hmr/client'

export async function fetchExtensionManifest(init?: RequestInit): Promise<ExtensionManifest> {
	return getHmrWebClient().api.extensions.manifest(init)
}
