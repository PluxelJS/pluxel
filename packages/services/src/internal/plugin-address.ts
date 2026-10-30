import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { encodePluginNodeAddressBytes, type PluginNodeAddress } from '@pluxel/core'

export function pluginNodePhysicalKey(input: PluginNodeAddress): string {
	return bytesToHex(sha256(encodePluginNodeAddressBytes(input)))
}
