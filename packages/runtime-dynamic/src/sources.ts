import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import picomatch from 'picomatch'
import { normalizePath } from 'vite'

const MAX_DYNAMIC_SOURCE_ENTRIES = 10_000

export type DynamicPluginSource =
	| Readonly<{
			kind: 'file'
			/** Absolute path, or a path resolved relative to the dynamic runtime root. */
			path: string
	  }>
	| Readonly<{
			kind: 'directory'
			/** Absolute path, or a path resolved relative to the dynamic runtime root. */
			path: string
			/** Positive entry globs relative to this directory; traversal and negation are rejected. */
			include: readonly string[]
	  }>

export type ResolvedDynamicPluginSources = Readonly<{
	roots: readonly string[]
	entries: readonly string[]
	includeGlobs: readonly string[]
	declarations: readonly DynamicPluginSource[]
}>

export async function resolveDynamicPluginSources(
	root: string,
	sources: readonly DynamicPluginSource[] | undefined,
): Promise<ResolvedDynamicPluginSources> {
	const roots = new Set<string>()
	const entries = new Set<string>()
	const includeGlobs = new Set<string>()
	const declarations: DynamicPluginSource[] = []

	for (const source of sources ?? []) {
		assertDynamicPluginSource(source)
		if (source.kind === 'file') {
			const entry = normalizePath(resolve(root, source.path.trim()))
			declarations.push(Object.freeze({ kind: 'file', path: entry }))
			roots.add(normalizePath(resolve(entry, '..')))
			includeGlobs.add(entry)
			if (existsSync(entry)) {
				entries.add(entry)
				assertSourceEntryLimit(entries.size)
			}
			continue
		}

		const directory = normalizePath(resolve(root, source.path.trim()))
		const patterns = source.include.map(normalizeSourcePattern)
		declarations.push(
			Object.freeze({ kind: 'directory', path: directory, include: Object.freeze(patterns) }),
		)
		const matches = picomatch(patterns, { dot: true })
		roots.add(directory)
		for (const pattern of patterns) includeGlobs.add(normalizePath(resolve(directory, pattern)))

		if (!existsSync(directory)) continue
		for await (const entry of listFiles(directory)) {
			const relativeEntry = normalizePath(relative(directory, entry))
			if (!matches(relativeEntry)) continue
			entries.add(entry)
			assertSourceEntryLimit(entries.size)
		}
	}

	return Object.freeze({
		roots: Object.freeze([...roots].sort()),
		entries: Object.freeze([...entries].sort()),
		includeGlobs: Object.freeze([...includeGlobs].sort()),
		declarations: Object.freeze(declarations),
	})
}

export function assertDynamicPluginSources(
	value: unknown,
): asserts value is readonly DynamicPluginSource[] {
	if (value === undefined) return
	if (!Array.isArray(value)) {
		throw new TypeError('[runtime-dynamic] sources must be an array')
	}
	for (const source of value) assertDynamicPluginSource(source)
}

function assertDynamicPluginSource(value: unknown): asserts value is DynamicPluginSource {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('[runtime-dynamic] each source must be an object')
	}
	const source = value as Record<string, unknown>
	if (source.kind !== 'file' && source.kind !== 'directory') {
		throw new TypeError('[runtime-dynamic] source.kind must be "file" or "directory"')
	}
	if (typeof source.path !== 'string' || !source.path.trim() || source.path.includes('\0')) {
		throw new TypeError('[runtime-dynamic] source.path must be a non-empty string')
	}
	const allowed =
		source.kind === 'directory' ? new Set(['kind', 'path', 'include']) : new Set(['kind', 'path'])
	const unknown = Object.keys(source).filter((key) => !allowed.has(key))
	if (unknown.length > 0) {
		throw new Error(
			`[runtime-dynamic] source includes unsupported ${unknown.map((key) => `"${key}"`).join(', ')}`,
		)
	}
	if (source.kind === 'directory') {
		if (!Array.isArray(source.include) || source.include.length === 0) {
			throw new TypeError('[runtime-dynamic] directory source.include must be a non-empty array')
		}
		for (const pattern of source.include) normalizeSourcePattern(pattern)
	}
}

function normalizeSourcePattern(value: unknown): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new TypeError('[runtime-dynamic] source include patterns must be non-empty strings')
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
		throw new Error('[runtime-dynamic] source include patterns must stay inside their directory')
	}
	return pattern
}

function assertSourceEntryLimit(size: number): void {
	if (size <= MAX_DYNAMIC_SOURCE_ENTRIES) return
	throw new Error(
		`[runtime-dynamic] sources resolve to more than ${MAX_DYNAMIC_SOURCE_ENTRIES} entries; use narrower directory include globs`,
	)
}

async function* listFiles(root: string): AsyncGenerator<string> {
	const pending = [root]
	while (pending.length > 0) {
		const directory = pending.pop()!
		const children = await readdir(directory, { withFileTypes: true })
		for (const child of children) {
			const path = normalizePath(resolve(directory, child.name))
			if (child.isDirectory()) pending.push(path)
			else if (child.isFile()) yield path
		}
	}
}
