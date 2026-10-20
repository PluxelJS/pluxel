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

const MAX_PENDING_FILES = 4096
const VALIDATION_WINDOW_MS = 25
type FileEvent = 'add' | 'change' | 'unlink'

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
	let validations = 0
	let pending = new Map<string, FileEvent>()
	let full = false
	let dirty = false
	let timer: ReturnType<typeof setTimeout> | undefined
	const cancelTimer = () => {
		clearTimeout(timer)
		timer = undefined
	}
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
		cancelTimer()
		pending.clear()
		full = false
		dirty = false
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
	const schedule = (): void => {
		if (closed || !ready || !dirty || timer || validations > 0) return
		// A fixed window joins a burst without deferring forever during continuous edits.
		timer = setTimeout(() => {
			timer = undefined
			void validate(false).catch(() => {})
		}, VALIDATION_WINDOW_MS)
		timer.unref()
	}
	const publish = (file: string, type: FileEvent, paths: ReadonlySet<string>): void => {
		const existed = entries.has(file)
		if (!paths.has(file)) {
			if (!existed) return
			entries.delete(file)
			options.onChange(Object.freeze({ type: 'unlink', path: file }))
		} else if (type !== 'unlink') {
			entries.add(file)
			options.onChange(Object.freeze({ type: existed ? 'change' : 'add', path: file }))
		}
	}
	const retain = (file: string, type: FileEvent): void => {
		if (full) return
		pending.set(file, type)
		if (pending.size > MAX_PENDING_FILES) {
			pending.clear()
			full = true
		}
	}
	const validate = (read: boolean): Promise<readonly string[]> => {
		cancelTimer()
		validations++
		const result = processing.then(async () => {
			if (closed) throw new Error('[host-vite] source watcher is closed')
			// Take the batch only when its turn starts, including any previous failed
			// validation. Notifications arriving during this snapshot stay pending.
			const batch = pending
			const reconcile = full
			pending = new Map()
			full = false
			dirty = false
			let discovered: readonly string[]
			try {
				discovered = await snapshot()
			} catch (error) {
				if (!closed) {
					if (reconcile) {
						pending.clear()
						full = true
					} else for (const [file, type] of batch) if (!pending.has(file)) retain(file, type)
				}
				// Keep failed observations, but only a new event or explicit read retries them.
				// In particular, restoring the batch must not mark it dirty again.
				throw error
			}
			const paths = new Set(discovered.map(normalize))
			if (closed) throw new Error('[host-vite] source watcher is closed')
			if (reconcile) {
				// Recover the SDK's observation set on overflow. Discovery alone must never
				// admit files that Chokidar has not observed, including raw-only notifications.
				for (const file of entries) if (!paths.has(file)) publish(file, 'unlink', paths)
				for (const [directory, children] of Object.entries(watcher.getWatched())) {
					for (const child of children) {
						const file = normalize(resolve(directory, child))
						if (matches(file) && paths.has(file)) publish(file, 'change', paths)
					}
				}
			} else for (const [file, type] of batch) publish(file, type, paths)
			return Object.freeze([...entries].sort())
		})
		// Explicit reads own their failures; background validation reports through onError.
		// Both keep one serial IO owner, and close drains the accepted operation.
		processing = result.then(
			(): undefined => {
				validations--
				schedule()
				return undefined
			},
			(error: unknown) => {
				validations--
				schedule()
				if (!read && !closed) options.onError(error)
			},
		)
		return result
	}
	const observed = (file: string, type: FileEvent | 'addDir'): void => {
		if (closed) return
		try {
			const normalized = normalize(resolve(file))
			if (type !== 'addDir' && !matches(normalized)) return
			// SDK readiness owns the initial observation epoch; validate it once below.
			if (!ready) {
				if (type === 'unlink') entries.delete(normalized)
				else if (type !== 'addDir') entries.add(normalized)
				return
			}
			if (type !== 'addDir') retain(normalized, type)
			dirty = true
			schedule()
		} catch (error) {
			if (!ready) initialFailure ??= error
			else options.onError(error)
		}
	}
	for (const type of ['add', 'change', 'unlink', 'addDir'] as const)
		watcher.on(type, (file) => observed(file, type))
	// Chokidar omits rejected/dangling links. Raw events only request validation by
	// the same discovery; regular file admission waits for its SDK observer.
	watcher.on('raw', (_event, file) => {
		if (ready && !closed && related(normalize(resolve(file)), root)) {
			dirty = true
			schedule()
		}
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
				// One queued validation, including retained failures. It takes one snapshot
				// when its turn starts and never waits for later notifications to stop.
				return validate(true)
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
