import type { VaultServiceConfig } from './types'

export function snapshotVaultConfig(input: VaultServiceConfig = {}): Readonly<VaultServiceConfig> {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new TypeError('[core.vault] config must be an object')
	for (const key of Reflect.ownKeys(input)) {
		if (key !== 'backend' && key !== 'deployIdentity' && key !== 'durable')
			throw new TypeError(`[core.vault] Unknown option: ${String(key)}`)
		if (!('value' in Object.getOwnPropertyDescriptor(input, key)!))
			throw new TypeError('[core.vault] config cannot contain accessors')
	}
	if (input.backend !== undefined && !['encrypted', 'bindings'].includes(input.backend))
		throw new TypeError('[core.vault] backend must be encrypted or bindings')
	if (input.deployIdentity !== undefined && typeof input.deployIdentity !== 'string')
		throw new TypeError('[core.vault] deployIdentity must be a string')
	if (input.durable !== undefined && typeof input.durable !== 'boolean')
		throw new TypeError('[core.vault] durable must be a boolean')
	if (input.backend === 'bindings' && input.durable)
		throw new TypeError('[core.vault] durable storage requires the encrypted backend')
	return Object.freeze({ ...input })
}
