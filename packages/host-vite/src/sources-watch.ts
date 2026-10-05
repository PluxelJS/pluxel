import { dirname, relative, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import { watch } from 'chokidar'
import { pluginSource, type PluginSource } from '@pluxel/host/sources'
import {
	discoverPluginSources,
	pluginSourceCovers,
	resolvePluginSourcePath,
} from '@pluxel/host/internal'
import { hostFileWatchOptions } from './internal/watch-policy'
import type { PluginSourceOpenOptions, PluginSourceWatch } from './source-session'

/** Watch one immutable declaration; Host owns composition and deduplication across sources. */
export async function watchPluginSource(
	source: PluginSource,
	options: PluginSourceOpenOptions,
): Promise<PluginSourceWatch> {
	options.signal?.throwIfAborted()
	const declaration = pluginSource(source)
	await discoverPluginSources({ root: options.root, sources: [declaration] })
	const declaredPath = normalize(resolve(options.root, declaration.path))
	const ancestor = existingAncestor(dirname(declaredPath))
	const watchRoot = normalize(await realpath(ancestor))
	const initial = await resolvePluginSourcePath(declaration, options.root)
	const path = normalize(initial ?? resolve(watchRoot, relative(ancestor, declaredPath)))
	const resolvedSource = pluginSource({ ...declaration, path })
	const root = declaration.kind === 'file' ? dirname(path) : path
	const matches = (file: string): boolean =>
		pluginSourceCovers({
			source: resolvedSource,
			root: options.root,
			requirement: { kind: 'file', path: file },
		})
	const covers = (file: string): boolean =>
		matches(file) ||
		pluginSourceCovers({
			source: declaration,
			root: options.root,
			requirement: { kind: 'file', path: file },
		})
	const entries = new Set<string>()
	let ready = false
	let closed = false
	let closing: Promise<void> | undefined
	let processing = Promise.resolve()
	let initialFailure: unknown
	options.signal?.throwIfAborted()
	const policy = hostFileWatchOptions()
	const watcher = watch(watchRoot, {
		...policy,
		ignoreInitial: false,
		followSymlinks: false,
		ignored: (file, stats) => {
			const normalized = normalize(resolve(file))
			// Shared discovery reports rejected links. Excluding them from SDK tracking
			// lets a regular replacement install its own file/directory observer.
			if (stats?.isSymbolicLink()) return true
			if (normalized === path) return false
			if (stats?.isFile()) return !matches(normalized)
			return declaration.kind === 'directory'
				? !related(normalized, root)
				: !relatedAncestor(normalized, root)
		},
	})
	const close = (): Promise<void> => {
		closed = true
		options.signal?.removeEventListener('abort', abort)
		return (closing ??= (async () => {
			const results = await Promise.allSettled([watcher.close(), processing])
			const failures = results.flatMap((result) =>
				result.status === 'rejected' ? [result.reason] : [],
			)
			if (failures.length > 0)
				throw new AggregateError(failures, '[host-vite] source cleanup failed')
		})())
	}
	const abort = (): void => {
		// The held close Promise remains observable to the session's owner.
		void close().catch(() => {})
	}
	options.signal?.addEventListener('abort', abort, { once: true })
	const observe = (operation: () => Promise<void>): void => {
		if (closed) return
		processing = processing
			.then(async () => {
				if (closed) return
				return operation()
			})
			.catch((error) => {
				if (closed) return
				if (!ready) initialFailure ??= error
				else options.onError(error)
			})
	}
	const snapshot = async (): Promise<readonly string[]> => {
		const missingLiveFile = (error: unknown): undefined => {
			if (
				!ready ||
				declaration.kind !== 'file' ||
				!error ||
				typeof error !== 'object' ||
				!('code' in error) ||
				error.code !== 'ENOENT'
			)
				throw error
			return undefined
		}
		// Shared leaf validation preserves SYMLINK precedence. Check the fixed parent
		// before directory discovery can read another physical owner's entries.
		const leaf = await resolvePluginSourcePath(resolvedSource, options.root).catch(missingLiveFile)
		const materialized = existingAncestor(dirname(path))
		const physical = normalize(await realpath(materialized))
		if (physical !== materialized)
			throw Object.assign(
				new TypeError(
					`[host-vite] Plugin source physical path changed: ${path}; ${materialized} now resolves to ${physical}. Restore the captured path or restart the Vite application to resolve parent aliases again`,
				),
				{ code: 'PLUGIN_SOURCE_PATH_CHANGED', file: path },
			)
		if (leaf === undefined && declaration.kind === 'file') return []
		return await discoverPluginSources({ root: options.root, sources: [resolvedSource] }).catch(
			(error: unknown): readonly string[] => {
				missingLiveFile(error)
				return []
			},
		)
	}
	const observed = (file: string, type: 'add' | 'change' | 'unlink' | 'addDir'): void => {
		observe(async () => {
			// SDK readiness owns the initial observation epoch. Validate the completed
			// epoch once before returning, instead of rescanning its directory per add.
			if (!ready) {
				if (type === 'addDir') return
				const normalized = normalize(resolve(file))
				if (!matches(normalized)) return
				if (type === 'unlink') entries.delete(normalized)
				else entries.add(normalized)
				return
			}
			const paths = await snapshot()
			if (closed || type === 'addDir') return
			const normalized = normalize(resolve(file))
			if (!matches(normalized)) return
			const existed = entries.has(normalized)
			if (!paths.map(normalize).includes(normalized)) {
				if (!existed) return
				entries.delete(normalized)
				if (ready) options.onChange(Object.freeze({ type: 'unlink', path: normalized }))
			} else if (type !== 'unlink') {
				entries.add(normalized)
				if (ready)
					options.onChange(Object.freeze({ type: existed ? 'change' : 'add', path: normalized }))
			}
		})
	}
	for (const type of ['add', 'change', 'unlink', 'addDir'] as const)
		watcher.on(type, (file) => observed(file, type))
	// Chokidar omits rejected/dangling links. Raw events only request validation by
	// the same discovery; regular file admission waits for its SDK observer.
	watcher.on('raw', (_event, file) => {
		if (ready && !closed && related(normalize(resolve(file)), root))
			observe(async () => {
				await snapshot()
			})
	})
	try {
		await new Promise<void>((resolveReady, reject) => {
			const onAbort = (): void =>
				reject(options.signal?.reason ?? new Error('Source session aborted'))
			if (options.signal?.aborted) {
				onAbort()
				return
			}
			options.signal?.addEventListener('abort', onAbort, { once: true })
			watcher.once('ready', () => {
				options.signal?.removeEventListener('abort', onAbort)
				resolveReady()
			})
			watcher.on('error', (error) => {
				if (!ready) {
					initialFailure ??= error
					options.signal?.removeEventListener('abort', onAbort)
					reject(error)
				} else if (!closed) options.onError(error)
			})
		})
		const validated = processing.then(async (): Promise<undefined> => {
			if (initialFailure !== undefined) throw initialFailure
			await snapshot()
			return undefined
		})
		// close() drains the same accepted validation even if opening is aborted.
		processing = validated.then(
			(): undefined => undefined,
			(): undefined => undefined,
		)
		await validated
		options.signal?.throwIfAborted()
		ready = true
		return Object.freeze({
			entries(): Promise<readonly string[]> {
				const reading = processing.then(async () => {
					if (closed) throw new Error('[host-vite] source watcher is closed')
					await snapshot()
					if (closed) throw new Error('[host-vite] source watcher is closed')
					return Object.freeze([...entries].sort())
				})
				// The caller owns the validation failure; close still drains its accepted IO.
				processing = reading.then(
					(): undefined => undefined,
					(): undefined => undefined,
				)
				return reading
			},
			covers,
			close,
		})
	} catch (error) {
		const [cleanup] = await Promise.allSettled([close()])
		if (cleanup.status === 'rejected')
			throw new AggregateError(
				[error, cleanup.reason],
				'[host-vite] source startup and cleanup failed',
				{
					cause: error,
				},
			)
		throw error
	}
}

const normalize = (path: string): string => path.replaceAll('\\', '/')
function related(left: string, right: string): boolean {
	return relatedAncestor(left, right) || relatedAncestor(right, left)
}
function relatedAncestor(left: string, right: string): boolean {
	return left === right || right.startsWith(left.endsWith('/') ? left : `${left}/`)
}
function existingAncestor(path: string): string {
	while (true) {
		try {
			lstatSync(path)
			return path
		} catch (error) {
			if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
				throw error
		}
		const parent = dirname(path)
		if (parent === path) return path
		path = parent
	}
}
