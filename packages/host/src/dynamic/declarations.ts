import { isAbsolute } from 'node:path'

const normalizePath = (path: string): string => path.replaceAll('\\', '/')

export type DynamicPluginSource =
	| Readonly<{
			kind: 'file'
			/** Absolute path, or a path resolved relative to the application root. */
			path: string
	  }>
	| Readonly<{
			kind: 'directory'
			/** Absolute path, or a path resolved relative to the application root. */
			path: string
			/** Positive entry globs relative to this directory; traversal and negation are rejected. */
			include: readonly string[]
	  }>

export function assertDynamicPluginSource(value: unknown): asserts value is DynamicPluginSource {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('[host/dynamic] each source must be an object')
	}
	const source = value as Record<string, unknown>
	if (source.kind !== 'file' && source.kind !== 'directory') {
		throw new TypeError('[host/dynamic] source.kind must be "file" or "directory"')
	}
	if (typeof source.path !== 'string' || !source.path.trim() || source.path.includes('\0')) {
		throw new TypeError('[host/dynamic] source.path must be a non-empty string')
	}
	const allowed =
		source.kind === 'directory' ? new Set(['kind', 'path', 'include']) : new Set(['kind', 'path'])
	const unknown = Object.keys(source).filter((key) => !allowed.has(key))
	if (unknown.length > 0) {
		throw new Error(
			`[host/dynamic] source includes unsupported ${unknown.map((key) => `"${key}"`).join(', ')}`,
		)
	}
	if (source.kind === 'directory') {
		if (!Array.isArray(source.include) || source.include.length === 0) {
			throw new TypeError('[host/dynamic] directory source.include must be a non-empty array')
		}
		for (const pattern of source.include) normalizeSourcePattern(pattern)
	}
}

function normalizeSourcePattern(value: unknown): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new TypeError('[host/dynamic] source include patterns must be non-empty strings')
	}
	const pattern = normalizePath(value.trim())
	const segments = pattern.split('/')
	if (
		pattern.includes('\0') ||
		pattern.includes('!') ||
		pattern.includes('..') ||
		isAbsolute(pattern) ||
		/^[a-zA-Z]:\//.test(pattern) ||
		segments.includes('.') ||
		segments.includes('..')
	) {
		throw new Error('[host/dynamic] source include patterns must stay inside their directory')
	}
	return pattern
}
