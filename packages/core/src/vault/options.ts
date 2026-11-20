import type { VaultServiceConfig } from './types'

export function snapshotVaultConfig(input: VaultServiceConfig = {}): Readonly<VaultServiceConfig> {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new TypeError('[core.vault] config must be an object')
	for (const key of Reflect.ownKeys(input)) {
		if (key !== 'backend' && key !== 'deployIdentity')
			throw new TypeError(`[core.vault] Unknown option: ${String(key)}`)
		if (!('value' in Object.getOwnPropertyDescriptor(input, key)!))
			throw new TypeError('[core.vault] config cannot contain accessors')
	}
	if (input.backend !== undefined && !['encrypted', 'bindings'].includes(input.backend))
		throw new TypeError('[core.vault] backend must be encrypted or bindings')
	if (input.deployIdentity !== undefined && typeof input.deployIdentity !== 'string')
		throw new TypeError('[core.vault] deployIdentity must be a string')
	return Object.freeze({ ...input })
}
