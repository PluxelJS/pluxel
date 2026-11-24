import { parsePluginNodeAddress, pluginNodeIndexKey } from '@pluxel/core'
import type { WorkbenchEntryLink } from './client-protocol.ts'

/** Reads capability-free data without resolving or opening the referenced entry. */
export function readWorkbenchEntryLink(input: unknown): WorkbenchEntryLink {
	if (
		!input ||
		typeof input !== 'object' ||
		Array.isArray(input) ||
		!Object.hasOwn(input, 'target') ||
		!Object.hasOwn(input, 'entryKey') ||
		Object.keys(input).some((key) => !['target', 'entryKey', 'location'].includes(key))
	) {
		throw new TypeError(
			'[workbench] entry link must contain target, entryKey and optional location',
		)
	}
	const record = input as Record<string, unknown>
	const target = parsePluginNodeAddress(record.target)
	const entryKey = record.entryKey
	if (
		typeof entryKey !== 'string' ||
		entryKey.length > 128 ||
		!/^[A-Za-z][A-Za-z0-9_]*$/.test(entryKey) ||
		['__proto__', 'constructor', 'prototype', 'then'].includes(entryKey)
	) {
		throw new TypeError('[workbench] entry link entryKey must be a declared entry key')
	}
	const location = Object.hasOwn(record, 'location') ? record.location : undefined
	if (location === undefined) return Object.freeze({ target, entryKey })
	if (
		typeof location !== 'string' ||
		location.length > 4096 ||
		!location.startsWith('/') ||
		location.startsWith('//') ||
		location.includes('\\') ||
		[...location].some((character) => character.charCodeAt(0) <= 32)
	) {
		throw new TypeError('[workbench] entry link location must be a concrete local path')
	}
	const url = new URL(location, 'https://workbench.invalid')
	if (
		url.pathname + url.search + url.hash !== location ||
		url.pathname.includes('//') ||
		(url.pathname !== '/' && url.pathname.endsWith('/'))
	) {
		throw new TypeError('[workbench] entry link location must be canonical')
	}
	for (const segment of url.pathname.split('/')) {
		if (/[\\/]/.test(decodeURIComponent(segment))) {
			throw new TypeError('[workbench] entry link location contains an invalid segment')
		}
	}
	return Object.freeze({ target, entryKey, location })
}

/** Sidebar preferences allow one shortcut per target and entry key. */
export function readWorkbenchShortcuts(input: unknown): readonly WorkbenchEntryLink[] {
	if (!Array.isArray(input)) throw new TypeError('[workbench] shortcuts must be an array')
	const identities = new Set<string>()
	return Object.freeze(
		Array.from(input, (value, index) => {
			let link: WorkbenchEntryLink
			try {
				link = readWorkbenchEntryLink(value)
			} catch (cause) {
				throw new TypeError(
					`[workbench] invalid sidebar shortcut at index ${index}: ${String(cause)}`,
					{ cause },
				)
			}
			const identity = JSON.stringify([pluginNodeIndexKey(link.target), link.entryKey])
			if (identities.has(identity)) throw new TypeError('[workbench] duplicate sidebar shortcut')
			identities.add(identity)
			return link
		}),
	)
}
