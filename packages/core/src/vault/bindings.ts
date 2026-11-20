import { pluginNodePhysicalKey } from '../internal/plugin-address'
import { parsePluginNodeAddress } from '../plugins/runtime/identity'
import { VaultError } from './error'
import { validateKey } from './paths'
import type { VaultBindingRecord } from './types'
import { cloneJson, freezeJson } from './value'

/** Capture deployment inputs before Host IO and reject conflicting authoritative records. */
export function snapshotVaultBindings(
	records: readonly VaultBindingRecord[],
): readonly VaultBindingRecord[] {
	if (!Array.isArray(records)) throw new TypeError('[core.vault] bindings must be an array')
	const keys = new Set<string>()
	return Object.freeze(
		records.map((record) => {
			if (!record || typeof record !== 'object' || Array.isArray(record))
				throw new TypeError('[core.vault] binding must be an object')
			for (const key of Reflect.ownKeys(record)) {
				if (
					typeof key !== 'string' ||
					!['owner', 'namespace', 'key', 'value', 'source'].includes(key)
				)
					throw new TypeError(`[core.vault] Unknown binding field: ${String(key)}`)
				if (!('value' in Object.getOwnPropertyDescriptor(record, key)!))
					throw new TypeError('[core.vault] binding cannot contain accessors')
			}
			validateKey(record.key)
			if (record.namespace !== undefined) validateKey(record.namespace)
			if (record.source !== 'env' && record.source !== 'file')
				throw new TypeError('[core.vault] binding source must be env or file')
			const owner = parsePluginNodeAddress(record.owner)
			const identity = JSON.stringify([
				pluginNodePhysicalKey(owner),
				record.namespace ?? null,
				record.key,
			])
			if (keys.has(identity))
				throw new VaultError('INVALID_CONFIG', 'Duplicate Vault deployment binding.')
			keys.add(identity)
			return Object.freeze({
				...record,
				owner,
				value: record.value === undefined ? undefined : freezeJson(cloneJson(record.value)),
			})
		}),
	)
}
