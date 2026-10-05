import { isAbsolute, relative, resolve } from 'node:path'
import picomatch from 'picomatch'
import type { Context } from '@pluxel/core'

const normalizePath = (path: string): string => path.replaceAll('\\', '/')

export type PluginSource =
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

export function assertPluginSourceDeclaration(value: unknown): asserts value is PluginSource {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('[host/sources] each source must be an object')
	}
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null)
		throw new TypeError('[host/sources] source must be plain data')
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!
		if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor))
			throw new TypeError('[host/sources] source must contain only enumerable data fields')
	}
	const source = value as Record<string, unknown>
	if (source.kind !== 'file' && source.kind !== 'directory') {
		throw new TypeError('[host/sources] source.kind must be "file" or "directory"')
	}
	if (typeof source.path !== 'string' || !source.path.trim() || source.path.includes('\0')) {
		throw new TypeError('[host/sources] source.path must be a non-empty string')
	}
	const allowed =
		source.kind === 'directory' ? new Set(['kind', 'path', 'include']) : new Set(['kind', 'path'])
	const unknown = Object.keys(source).filter((key) => !allowed.has(key))
	if (unknown.length > 0) {
		throw new Error(
			`[host/sources] source includes unsupported ${unknown.map((key) => `"${key}"`).join(', ')}`,
		)
	}
	if (source.kind === 'directory') {
		if (!Array.isArray(source.include) || source.include.length === 0) {
			throw new TypeError('[host/sources] directory source.include must be a non-empty array')
		}
		for (const pattern of source.include) normalizeSourcePattern(pattern)
	}
}

function normalizeSourcePattern(value: unknown): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new TypeError('[host/sources] source include patterns must be non-empty strings')
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
		throw new Error('[host/sources] source include patterns must stay inside their directory')
	}
	return pattern
}

export class PluginSourceRequiredError extends Error {
	constructor(public readonly code: 'SOURCE_REQUIRED' | 'SOURCE_NOT_DECLARED') {
		super(
			code === 'SOURCE_REQUIRED'
				? 'Host has no Plugin sources'
				: 'Required Plugin source is not declared by this host',
		)
		this.name = 'PluginSourceRequiredError'
	}
}

const sourcesByRoot = new WeakMap<
	Context['root'],
	Readonly<{ root: string; sources: readonly PluginSource[]; updates: 'next-start' | 'live' }>
>()

/** @internal Install the application declaration before activating any producer Plugin. */
export function installPluginSources(
	ctx: Context,
	options: { root: string; sources: readonly PluginSource[]; updates: 'next-start' | 'live' },
): void {
	if (!isAbsolute(options.root)) throw new TypeError('[host/sources] root must be absolute')
	if (sourcesByRoot.has(ctx.root)) throw new Error('[host] Plugin sources are already installed')
	sourcesByRoot.set(
		ctx.root,
		Object.freeze({
			root: options.root,
			sources: Object.freeze(options.sources.map(pluginSource)),
			updates: options.updates,
		}),
	)
	ctx.root.effects.defer(
		() => {
			sourcesByRoot.delete(ctx.root)
		},
		{ tag: 'PluginSources', phase: 'shutdown' },
	)
}

/** Validate publication coverage before starting IO. The result describes consumption, not application of a publication. */
export function requirePluginSource(
	ctx: Context,
	requirement: PluginSource,
): Readonly<{ updates: 'next-start' | 'live' }> {
	assertPluginSourceDeclaration(requirement)
	const config = sourcesByRoot.get(ctx.root)
	if (!config || config.sources.length === 0) throw new PluginSourceRequiredError('SOURCE_REQUIRED')
	if (
		!config.sources.some((source) => pluginSourceCovers({ source, root: config.root, requirement }))
	)
		throw new PluginSourceRequiredError('SOURCE_NOT_DECLARED')
	return Object.freeze({ updates: config.updates })
}

/** Validate, copy and freeze one file/directory declaration. Creation starts no IO. */
export function pluginSource(declaration: PluginSource): PluginSource {
	assertPluginSourceDeclaration(declaration)
	return declaration.kind === 'file'
		? Object.freeze({ kind: 'file', path: declaration.path.trim() })
		: Object.freeze({
				kind: 'directory',
				path: declaration.path.trim(),
				include: Object.freeze(declaration.include.map(normalizeSourcePattern)),
			})
}

/** @internal Structural source identity, independent of execution and object identity. */
export function pluginSourceKey(source: PluginSource): string {
	return JSON.stringify(pluginSource(source))
}

/** @internal Shared matching rules for native discovery, Vite observation and producers. */
export function pluginSourceCovers({
	source,
	root,
	requirement,
}: {
	source: PluginSource
	root: string
	requirement: PluginSource
}): boolean {
	const path = normalizePath(resolve(root, source.path))
	const requested = normalizePath(resolve(root, requirement.path))
	if (source.kind === 'file') return requirement.kind === 'file' && path === requested
	if (requirement.kind === 'file') {
		const name = normalizePath(relative(path, requested))
		return (
			name !== '' &&
			!isAbsolute(name) &&
			name !== '..' &&
			!name.startsWith('../') &&
			picomatch([...source.include], { dot: true })(name)
		)
	}
	const patterns = new Set(source.include.map(normalizePath))
	return (
		path === requested &&
		requirement.include.every((pattern) => patterns.has(normalizePath(pattern)))
	)
}
