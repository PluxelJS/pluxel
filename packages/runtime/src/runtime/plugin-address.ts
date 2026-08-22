import { createHash } from 'node:crypto'
import { encodePluginNodeAddressBytes, type PluginNodeAddress } from '@pluxel/core'

export function pluginNodePhysicalKey(input: PluginNodeAddress): string {
	return createHash('sha256').update(encodePluginNodeAddressBytes(input)).digest('hex')
}
