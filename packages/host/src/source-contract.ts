import { type Context } from '@pluxel/core'
import { isAbsolute, relative, resolve } from 'node:path'
import picomatch from 'picomatch'

const normalizePath = (path: string): string => path.replaceAll('\\', '/')

export type PluginSource =
	| Readonly<{
			/** Absolute path, or a path resolved relative to the application root. */
			file: string
			directory?: never
			include?: never
	  }>
	| Readonly<{
			/** Absolute path, or a path resolved relative to the application root. */
			directory: string
			file?: never
			/** Positive entry globs relative to this directory; traversal and negation are rejected. */
			include: readonly string[]
	  }>

/** @internal Validate and detach a discovery declaration before using it. */
export function snapshotPluginSource(value: unknown): PluginSource {
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
	const file = Object.hasOwn(source, 'file')
	const directory = Object.hasOwn(source, 'directory')
	if (file === directory)
		throw new TypeError('[host/sources] each source must specify exactly one of file or directory')
	const field = file ? 'file' : 'directory'
	const path = source[field]
	if (typeof path !== 'string' || !path.trim() || path.includes('\0'))
		throw new TypeError(`[host/sources] source.${field} must be a non-empty string`)
	for (const key of Object.keys(source))
		if (key !== field && !(directory && key === 'include'))
			throw new TypeError(`[host/sources] ${field} source includes unsupported "${key}"`)
	if (file) return Object.freeze({ file: path.trim() })
	if (!Array.isArray(source.include) || source.include.length === 0)
		throw new TypeError('[host/sources] directory source.include must be a non-empty array')
	return Object.freeze({
		directory: path.trim(),
		include: Object.freeze(Array.from(source.include, normalizeSourcePattern)),
	})
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
			sources: Object.freeze(options.sources.map(snapshotPluginSource)),
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
	const required = snapshotPluginSource(requirement)
	const config = sourcesByRoot.get(ctx.root)
	if (!config || config.sources.length === 0) throw new PluginSourceRequiredError('SOURCE_REQUIRED')
	if (
		!config.sources.some((source) =>
			pluginSourceCovers({ source, root: config.root, requirement: required }),
		)
	)
		throw new PluginSourceRequiredError('SOURCE_NOT_DECLARED')
	return Object.freeze({ updates: config.updates })
}

/** @internal Structural source identity, independent of execution and object identity. */
export function pluginSourceKey(source: PluginSource): string {
	return JSON.stringify(source)
}

/** @internal Match entry paths against one validated declaration. */
export function pluginSourceMatcher(source: PluginSource, root: string): (file: string) => boolean {
	if (source.file !== undefined) {
		const path = normalizePath(resolve(root, source.file))
		return (file) => normalizePath(resolve(root, file)) === path
	}
	const directory = resolve(root, source.directory)
	const match = picomatch([...source.include], { dot: true })
	return (file) => {
		const name = normalizePath(relative(directory, resolve(root, file)))
		return (
			name !== '' && !isAbsolute(name) && name !== '..' && !name.startsWith('../') && match(name)
		)
	}
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
	if (requirement.file !== undefined) return pluginSourceMatcher(source, root)(requirement.file)
	if (source.directory === undefined) return false
	const patterns = new Set(source.include)
	return (
		resolve(root, source.directory) === resolve(root, requirement.directory) &&
		requirement.include.every((pattern) => patterns.has(pattern))
	)
}
