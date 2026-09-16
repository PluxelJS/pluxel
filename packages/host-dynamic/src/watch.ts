import { dirname, relative, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { watch } from 'chokidar'
import picomatch from 'picomatch'
import { assertDynamicPluginSources, type DynamicPluginSource } from './declarations'

export type SourceChange = Readonly<{ type: 'add' | 'change' | 'unlink'; path: string }>
export type DynamicSourceSession = Readonly<{
	/** Snapshot at readiness. Subsequent changes are delivered through onChange. */
	entries: readonly string[]
	/** Stops admission synchronously and waits for the watcher to close. Idempotent. */
	close(): Promise<void>
}>

/** Initial discovery and later publication use one watcher, including initially absent directories. */
export async function watchDynamicSources(options: {
	root: string
	sources: readonly DynamicPluginSource[]
	onChange(change: SourceChange): void
	onError(error: unknown): void
	/** Abort stops notifications and closes the watcher; it does not cancel a caller's module evaluation. */
	signal?: AbortSignal
}): Promise<DynamicSourceSession> {
	assertDynamicPluginSources(options.sources)
	options.signal?.throwIfAborted()
	const selectors = options.sources.map((source) => {
		const path = normalize(resolve(options.root, source.path))
		const matches =
			source.kind === 'directory' ? picomatch([...source.include], { dot: true }) : undefined
		return source.kind === 'file'
			? { kind: source.kind, path, root: dirname(path), match: (entry: string) => entry === path }
			: {
					kind: source.kind,
					path,
					root: path,
					match: (entry: string) => {
						const name = normalize(relative(path, entry))
						return name !== '' && !name.startsWith('../') && matches!(name)
					},
				}
	})
	const roots = [...new Set(selectors.map((selector) => existingAncestor(selector.root)))]
	const entries = new Set<string>()
	let ready = false
	let closed = false
	let closing: Promise<void> | undefined
	const watcher = watch(roots, {
		ignoreInitial: false,
		followSymlinks: false,
		ignored: (path, stats) => {
			const normalized = normalize(resolve(path))
			return stats?.isFile()
				? !selectors.some((selector) => selector.match(normalized))
				: !selectors.some((selector) =>
						selector.kind === 'directory'
							? related(normalized, selector.root)
							: normalized === selector.root ||
								selector.root.startsWith(normalized.endsWith('/') ? normalized : `${normalized}/`),
					)
		},
	})
	const close = (): Promise<void> => {
		closed = true
		options.signal?.removeEventListener('abort', abort)
		return (closing ??= watcher.close())
	}
	const abort = (): void => {
		void close()
	}
	options.signal?.addEventListener('abort', abort, { once: true })
	for (const type of ['add', 'change', 'unlink'] as const) {
		watcher.on(type, (path) => {
			if (closed) return
			const normalized = normalize(resolve(path))
			if (!selectors.some((selector) => selector.match(normalized))) return
			if (type === 'unlink') entries.delete(normalized)
			else entries.add(normalized)
			if (ready) options.onChange(Object.freeze({ type, path: normalized }))
		})
	}
	try {
		await new Promise<void>((resolveReady, reject) => {
			const onAbort = (): void =>
				reject(options.signal?.reason ?? new Error('Source session aborted'))
			options.signal?.addEventListener('abort', onAbort, { once: true })
			watcher.once('ready', () => {
				options.signal?.removeEventListener('abort', onAbort)
				resolveReady()
			})
			watcher.on('error', (error) => {
				if (!ready) {
					options.signal?.removeEventListener('abort', onAbort)
					reject(error)
				} else if (!closed) options.onError(error)
			})
		})
		options.signal?.throwIfAborted()
		ready = true
		return Object.freeze({ entries: Object.freeze([...entries].sort()), close })
	} catch (error) {
		await close()
		throw error
	}
}

const normalize = (path: string): string => path.replaceAll('\\', '/')
function related(left: string, right: string): boolean {
	const leftPrefix = left.endsWith('/') ? left : `${left}/`
	const rightPrefix = right.endsWith('/') ? right : `${right}/`
	return left === right || left.startsWith(rightPrefix) || right.startsWith(leftPrefix)
}
function existingAncestor(path: string): string {
	while (!existsSync(path)) {
		const parent = dirname(path)
		if (parent === path) break
		path = parent
	}
	return path
}
