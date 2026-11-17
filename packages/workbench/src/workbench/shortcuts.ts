import { parsePluginNodeAddress, pluginNodeIndexKey } from '@pluxel/core'
import type { WorkbenchShortcut } from './client-protocol.ts'

/** Validates preference data without resolving or opening a Plugin entry. */
export function readWorkbenchShortcuts(input: unknown): readonly WorkbenchShortcut[] {
	if (!Array.isArray(input)) throw new TypeError('[workbench] shortcuts must be an array')
	const identities = new Set<string>()
	return Object.freeze(
		Array.from(input, (value): WorkbenchShortcut => {
			if (
				!value ||
				typeof value !== 'object' ||
				Array.isArray(value) ||
				Object.keys(value).some((key) => !['target', 'entryKey', 'location'].includes(key))
			) {
				throw new TypeError(
					'[workbench] shortcut must contain target, entryKey and optional location',
				)
			}
			const target = parsePluginNodeAddress(value.target)
			const entryKey: unknown = value.entryKey
			if (
				typeof entryKey !== 'string' ||
				entryKey.length > 128 ||
				!/^[A-Za-z][A-Za-z0-9_]*$/.test(entryKey) ||
				['__proto__', 'constructor', 'prototype', 'then'].includes(entryKey)
			) {
				throw new TypeError('[workbench] shortcut.entryKey must be a declared entry key')
			}
			const identity = JSON.stringify([pluginNodeIndexKey(target), entryKey])
			if (identities.has(identity)) throw new TypeError('[workbench] duplicate sidebar shortcut')
			identities.add(identity)
			const location: unknown = value.location
			if (location !== undefined) {
				if (
					typeof location !== 'string' ||
					location.length > 4096 ||
					!location.startsWith('/') ||
					location.startsWith('//') ||
					location.includes('\\') ||
					[...location].some((character) => character.charCodeAt(0) <= 32)
				) {
					throw new TypeError('[workbench] shortcut.location must be a concrete local path')
				}
				const url = new URL(location, 'https://workbench.invalid')
				if (url.pathname + url.search + url.hash !== location) {
					throw new TypeError('[workbench] shortcut.location must be canonical')
				}
				for (const segment of url.pathname.split('/')) {
					if (/[\\/]/.test(decodeURIComponent(segment))) {
						throw new TypeError('[workbench] shortcut.location contains an invalid segment')
					}
				}
			}
			return Object.freeze({
				target,
				entryKey,
				...(location === undefined ? {} : { location: location as string }),
			})
		}),
	)
}
